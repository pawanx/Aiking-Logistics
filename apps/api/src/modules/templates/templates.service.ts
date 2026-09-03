import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  TemplateStatus,
  type CreateTemplateRequest,
  type TemplateDto,
} from '@aiking/shared';
import type { Prisma, Template } from '@prisma/client';

import {
  ConflictingDuplicateException,
  NotFoundException,
  TemplateNotApprovedException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient, isUniqueViolation } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';

/** `{{variableName}}` — the placeholder syntax used in template bodies. */
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export interface ListTemplatesQuery {
  channel?: Channel;
  status?: TemplateStatus;
}

/**
 * Message templates — spec §6.1.
 *
 * The reason this is its own module rather than a field on `campaigns`: §6.1 notes that
 * "WhatsApp requires templates to be pre-approved by Meta, which has multi-day external
 * lead time". So approval state is a first-class lifecycle
 * (`draft → pending_approval → approved | rejected`), and a WhatsApp campaign refuses to
 * launch on anything but `approved`. That refusal is here, in `assertLaunchable`, so
 * campaigns and calls cannot each invent their own version of the rule.
 *
 * Email templates need no external approval, so they are launchable from `draft`.
 */
@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tenantContext: TenantContext,
  ) {}

  async list(query: ListTemplatesQuery = {}): Promise<TemplateDto[]> {
    const rows = await this.prisma.template.findMany({
      where: {
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ channel: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toTemplateDto);
  }

  async get(templateId: string): Promise<TemplateDto> {
    return toTemplateDto(await this.require(templateId));
  }

  async create(request: CreateTemplateRequest, createdBy: string): Promise<TemplateDto> {
    const name = (request.name ?? '').trim();
    const body = (request.body ?? '').trim();

    if (!name) throw new ValidationFailedException('A template needs a name');
    if (!body) throw new ValidationFailedException('A template needs a body');
    if (!Object.values(Channel).includes(request.channel)) {
      throw new ValidationFailedException('Unknown channel', { allowed: Object.values(Channel) });
    }
    if (request.channel === Channel.EMAIL && !request.subject?.trim()) {
      throw new ValidationFailedException('An email template needs a subject');
    }

    const template = await this.prisma.template
      .create({
        data: {
          // Named explicitly, from the JWT-derived scope and never from the request body.
          // The Prisma extension stamps this anyway, but it refuses a mismatch rather than
          // rewriting one — so writing it here is a second assertion, not a duplicate.
          tenantId: this.tenantContext.requireTenantId('templates.create'),
          name,
          channel: request.channel,
          language: request.language?.trim() || 'en',
          subject: request.subject?.trim() || null,
          body,
          variables: extractVariables(body, request.subject),
          status: TemplateStatus.DRAFT,
          createdBy,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictingDuplicateException(`A ${request.channel} template named "${name}" already exists`);
        }
        throw error;
      });

    return toTemplateDto(template);
  }

  /**
   * Edit a template.
   *
   * An approved template cannot be edited in place. Meta approved *specific content*;
   * silently changing the body under an `approved` flag would mean sending unapproved
   * content on an approval Meta granted for something else — which is how a WhatsApp
   * sender gets its quality rating cut (§15's "provider rate limits and template
   * rejections"). The edit is allowed but it resets the template to `draft`.
   */
  async update(templateId: string, patch: Partial<CreateTemplateRequest>): Promise<TemplateDto> {
    const existing = await this.require(templateId);

    const data: Prisma.TemplateUpdateInput = {};
    let contentChanged = false;

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ValidationFailedException('A template needs a name');
      data.name = name;
    }
    if (patch.subject !== undefined) {
      data.subject = patch.subject.trim() || null;
      contentChanged = true;
    }
    if (patch.body !== undefined) {
      const body = patch.body.trim();
      if (!body) throw new ValidationFailedException('A template needs a body');
      data.body = body;
      contentChanged = true;
    }
    if (patch.language !== undefined) {
      data.language = patch.language.trim() || 'en';
      contentChanged = true;
    }

    if (Object.keys(data).length === 0) {
      throw new ValidationFailedException('No recognised fields were supplied');
    }

    if (contentChanged) {
      const body = (patch.body ?? existing.body).trim();
      const subject = patch.subject ?? existing.subject ?? undefined;
      data.variables = extractVariables(body, subject);

      if (existing.channel === Channel.WHATSAPP && existing.status === TemplateStatus.APPROVED) {
        data.status = TemplateStatus.DRAFT;
        data.approvedAt = null;
        data.submittedAt = null;
        data.providerTemplateName = null;
        this.logger.warn(
          `template ${templateId} content changed after approval — reset to draft, resubmission required`,
        );
      }
    }

    return toTemplateDto(await this.prisma.template.update({ where: { id: templateId }, data }));
  }

  /**
   * Submit for provider approval — spec §6.1.
   *
   * In mock mode approval is granted immediately, so the pipeline is testable without a
   * multi-day wait. In live mode the template is left `pending_approval` for the real
   * Meta callback to resolve, which is why the two are distinguished by an argument
   * rather than by the caller's channel.
   */
  async submit(templateId: string, autoApprove: boolean): Promise<TemplateDto> {
    const existing = await this.require(templateId);

    if (existing.status === TemplateStatus.APPROVED) return toTemplateDto(existing);

    // Email needs no external approval at all — SES has no template review.
    if (existing.channel !== Channel.WHATSAPP) {
      return toTemplateDto(
        await this.prisma.template.update({
          where: { id: templateId },
          data: { status: TemplateStatus.APPROVED, submittedAt: new Date(), approvedAt: new Date() },
        }),
      );
    }

    const providerTemplateName = toProviderTemplateName(existing.name);

    return toTemplateDto(
      await this.prisma.template.update({
        where: { id: templateId },
        data: autoApprove
          ? {
              status: TemplateStatus.APPROVED,
              submittedAt: new Date(),
              approvedAt: new Date(),
              rejectionReason: null,
              providerTemplateName,
            }
          : {
              status: TemplateStatus.PENDING_APPROVAL,
              submittedAt: new Date(),
              rejectionReason: null,
              providerTemplateName,
            },
      }),
    );
  }

  /** Record a provider decision — called by the Meta webhook handler. */
  async recordDecision(
    templateId: string,
    decision: { approved: boolean; reason?: string; providerTemplateName?: string },
  ): Promise<TemplateDto> {
    await this.require(templateId);

    return toTemplateDto(
      await this.prisma.template.update({
        where: { id: templateId },
        data: decision.approved
          ? {
              status: TemplateStatus.APPROVED,
              approvedAt: new Date(),
              rejectionReason: null,
              ...(decision.providerTemplateName ? { providerTemplateName: decision.providerTemplateName } : {}),
            }
          : {
              status: TemplateStatus.REJECTED,
              approvedAt: null,
              rejectionReason: decision.reason ?? 'Rejected by the provider',
            },
      }),
    );
  }

  /** Pause a template without deleting it — stops new campaigns using it. */
  async pause(templateId: string): Promise<TemplateDto> {
    await this.require(templateId);
    return toTemplateDto(
      await this.prisma.template.update({ where: { id: templateId }, data: { status: TemplateStatus.PAUSED } }),
    );
  }

  async remove(templateId: string): Promise<void> {
    await this.require(templateId);
    // Campaigns reference templates with `onDelete: SetNull`, so a sent campaign keeps
    // its history and simply loses the link.
    await this.prisma.template.delete({ where: { id: templateId } });
  }

  /**
   * The launch gate — spec §6.1.
   *
   * Returns the row so the caller has the body and variable list it needs to render,
   * and throws `TemplateNotApprovedException` otherwise. Campaigns call this; nothing
   * else should reimplement the check.
   */
  async assertLaunchable(templateId: string, channel: Channel): Promise<Template> {
    const template = await this.require(templateId);

    if (template.channel !== channel) {
      throw new ValidationFailedException(
        `Template "${template.name}" is a ${template.channel} template and cannot be used for a ${channel} campaign`,
        { templateChannel: template.channel, campaignChannel: channel },
      );
    }

    if (template.status === TemplateStatus.PAUSED) {
      throw new TemplateNotApprovedException(template.name, template.status);
    }

    // Only WhatsApp gates on provider approval (§6.1). An email template is the
    // tenant's own content sent from their own domain — nobody external reviews it.
    if (template.channel === Channel.WHATSAPP && template.status !== TemplateStatus.APPROVED) {
      throw new TemplateNotApprovedException(template.name, template.status);
    }

    return template;
  }

  private async require(templateId: string): Promise<Template> {
    const template = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw new NotFoundException('Template', templateId);
    return template;
  }
}

/**
 * Render a template body against a contact's fields.
 *
 * An unresolved placeholder is left as-is rather than replaced with an empty string:
 * "Hello {{fullName}}" arriving verbatim is a visible bug someone fixes, whereas
 * "Hello " arriving looks like it worked.
 */
export function renderTemplate(body: string, variables: Record<string, unknown>): string {
  return body.replace(VARIABLE_PATTERN, (match, name: string) => {
    const value = variables[name];
    return value === undefined || value === null || value === '' ? match : String(value);
  });
}

/** Placeholders still unresolved after rendering — used to warn before a launch. */
export function missingVariables(body: string, variables: Record<string, unknown>): string[] {
  const missing = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]!;
    const value = variables[name];
    if (value === undefined || value === null || value === '') missing.add(name);
  }
  return [...missing];
}

export function extractVariables(body: string, subject?: string | null): string[] {
  const found = new Set<string>();
  for (const source of [body, subject ?? '']) {
    for (const match of source.matchAll(VARIABLE_PATTERN)) found.add(match[1]!);
  }
  return [...found];
}

/** Meta template names are lowercase alphanumeric with underscores. */
function toProviderTemplateName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

export function toTemplateDto(template: Template): TemplateDto {
  return {
    id: template.id,
    name: template.name,
    channel: template.channel as Channel,
    status: template.status as TemplateStatus,
    language: template.language,
    subject: template.subject,
    body: template.body,
    variables: template.variables,
    providerTemplateName: template.providerTemplateName,
    submittedAt: template.submittedAt?.toISOString() ?? null,
    approvedAt: template.approvedAt?.toISOString() ?? null,
    rejectionReason: template.rejectionReason,
    createdAt: template.createdAt.toISOString(),
  };
}

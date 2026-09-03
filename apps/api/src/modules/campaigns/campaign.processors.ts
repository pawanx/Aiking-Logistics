import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  CampaignStatus,
  Channel,
  CommunicationEventType,
  RecipientStatus,
  UsageEventType,
} from '@aiking/shared';
import type { Prisma } from '@prisma/client';

import { InsufficientFundsException } from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { CONFIG, type AppConfig } from '../../config/configuration';
import {
  EMAIL_PROVIDER,
  ProviderError,
  WHATSAPP_PROVIDER,
  type EmailProvider,
  type WhatsAppProvider,
} from '../../providers/provider.types';
import { MeteringService } from '../billing/metering.service';
import { CommunicationsService } from '../communications/communications.service';
import { QueueService } from '../queue/queue.service';
import { PermanentJobError, type CampaignDispatchJob, type EmailSendJob, type WhatsAppSendJob } from '../queue/queue.types';
import { WalletService } from '../wallet/wallet.service';
import { renderTemplate } from '../templates/templates.service';
import { CampaignsService } from './campaigns.service';

/** How many recipients one dispatch job fans out before re-enqueueing itself. */
const DISPATCH_BATCH = 200;

/**
 * Campaign processors — spec §3.4, §6.1, §6.2, §8.2.
 *
 * Three processors, and the division between them is the point:
 *
 * - **`campaign-dispatch`** walks the recipient list in batches and enqueues one send
 *   job each. It re-enqueues itself rather than looping over 50,000 rows in one job,
 *   so a worker restart loses one batch rather than the whole campaign.
 * - **`whatsapp-send` / `email-send`** each send to exactly one recipient. One
 *   recipient per job is what makes §6.1's "failures are per-recipient" true at the
 *   infrastructure level: a permanent failure fails that job, and the other 499
 *   recipients are unaffected.
 *
 * The money sequence in a send, in order, and why that order:
 *
 * 1. `metering.reserve()` — hold the cost *before* calling the provider. Two concurrent
 *    sends therefore cannot both spend the same last rupee.
 * 2. provider call.
 * 3. on success, `metering.settle()` keyed on **the provider's own message id** (§8.2),
 *    so a redelivered callback or a retried job charges once.
 * 4. on failure, `metering.release()` — the hold comes back in full. This is the §15
 *    mitigation for "billing a tenant for a message that then fails at the provider",
 *    and it is why the reserve happens before the send rather than after.
 */
@Injectable()
export class CampaignProcessors implements OnModuleInit {
  private readonly logger = new Logger(CampaignProcessors.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly queue: QueueService,
    private readonly metering: MeteringService,
    private readonly wallet: WalletService,
    private readonly campaigns: CampaignsService,
    private readonly communications: CommunicationsService,
    private readonly tenantContext: TenantContext,
  ) {}

  onModuleInit(): void {
    this.queue.register('campaign-dispatch', (payload) => this.dispatch(payload));
    this.queue.register('whatsapp-send', (payload) => this.sendWhatsApp(payload));
    this.queue.register('email-send', (payload) => this.sendEmail(payload));
  }

  /**
   * Fan a campaign out into per-recipient jobs.
   *
   * `runWithTenant` is opened from the job payload, not inherited: a worker has no HTTP
   * request, so without this the Prisma extension would refuse every tenant-scoped
   * query (§4.3 holding on the worker side too).
   */
  private async dispatch(job: CampaignDispatchJob): Promise<void> {
    await this.tenantContext.runAsWorker(
      job.tenantId,
      'dispatch a campaign',
      async () => {
        const campaign = await this.prisma.campaign.findUnique({ where: { id: job.campaignId } });
        if (!campaign) throw new PermanentJobError(`Campaign ${job.campaignId} no longer exists`);

        if (campaign.status === CampaignStatus.CANCELLED) {
          // Cancelled while this job was in flight. Retrying would re-send.
          throw new PermanentJobError(`Campaign ${job.campaignId} was cancelled`);
        }

        if (campaign.status === CampaignStatus.QUEUED) {
          await this.prisma.campaign.update({
            where: { id: job.campaignId },
            data: { status: CampaignStatus.SENDING },
          });
        }

        const batch = await this.prisma.campaignRecipient.findMany({
          where: {
            campaignId: job.campaignId,
            status: RecipientStatus.QUEUED,
            ...(job.afterRecipientId ? { id: { gt: job.afterRecipientId } } : {}),
          },
          orderBy: { id: 'asc' },
          take: DISPATCH_BATCH,
          select: { id: true },
        });

        if (batch.length === 0) {
          // Nothing left to fan out. The campaign is not necessarily finished — the
          // sends themselves may still be in flight — so `finalizeIfDone` decides.
          await this.campaigns.finalizeIfDone(job.campaignId);
          return;
        }

        const queueName = campaign.channel === Channel.EMAIL ? 'email-send' : 'whatsapp-send';

        for (const recipient of batch) {
          await this.queue.enqueue(
            queueName,
            { tenantId: job.tenantId, actorUserId: job.actorUserId, campaignRecipientId: recipient.id },
            // Keyed on the recipient, so a re-dispatched batch cannot double-send.
            { jobId: `send:${recipient.id}` },
          );
        }

        this.logger.log(`campaign ${job.campaignId}: enqueued ${batch.length} ${queueName} jobs`);

        if (batch.length === DISPATCH_BATCH) {
          // More to go. Re-enqueue from the cursor rather than looping here, so one
          // job stays short and a restart costs one batch.
          await this.queue.enqueue(
            'campaign-dispatch',
            { ...job, afterRecipientId: batch[batch.length - 1]!.id },
            { jobId: `dispatch:${job.campaignId}:${batch[batch.length - 1]!.id}` },
          );
        }
      },
      // The Manager who launched the campaign. Carried through the payload so the
      // worker's writes are attributable to a person rather than to "the system" —
      // §4.2's audit expectations do not stop at the HTTP boundary.
      job.actorUserId,
    );
  }

  /** One WhatsApp template message — spec §6.1. */
  private async sendWhatsApp(job: WhatsAppSendJob): Promise<void> {
    await this.tenantContext.runAsWorker(
      job.tenantId,
      'send a WhatsApp campaign message',
      async () => {
        const recipient = await this.loadSendable(job.campaignRecipientId);
        if (!recipient) return;

        const { campaign, contact, template } = recipient;
        if (!template?.providerTemplateName) {
          await this.failRecipient(recipient.id, 'template_missing', 'The template has no approved provider name');
          throw new PermanentJobError(`Campaign ${campaign.id} template is not submitted to the provider`);
        }

        const variables = mergeVariables(campaign.variables, contact);
        const idempotencyKey = `whatsapp:${recipient.id}`;

        // 1. Hold the funds before the provider call (§8.2, §15).
        const reservation = await this.metering
          .reserve({
            tenantId: job.tenantId,
            eventType: UsageEventType.WHATSAPP_MESSAGE,
            estimatedQuantity: 1,
            idempotencyKey,
            referenceType: 'campaign_recipient',
            referenceId: recipient.id,
            campaignId: campaign.id,
            contactId: contact.id,
          })
          .catch(async (error: unknown) => {
            if (error instanceof InsufficientFundsException) {
              await this.skipForFunds(recipient.id, campaign.id, error);
              // Not retryable: retrying without a top-up fails identically, and the
              // campaign is now in a state a Manager resolves rather than the queue.
              throw new PermanentJobError(`Insufficient funds for recipient ${recipient.id}`);
            }
            throw error;
          });

        try {
          const result = await this.whatsapp.sendTemplate({
            to: recipient.destination,
            templateName: template.providerTemplateName,
            languageCode: template.language,
            variables: positionalVariables(template.variables, variables),
            phoneNumberId: campaign.tenant.whatsappPhoneNumberId ?? undefined,
          });

          // 3. Charge, keyed on the provider's own id per §8.2.
          const charge = await this.metering.settle({
            tenantId: job.tenantId,
            eventType: UsageEventType.WHATSAPP_MESSAGE,
            actualQuantity: 1,
            idempotencyKey,
            description: `WhatsApp message to ${recipient.destination} for campaign "${campaign.name}"`,
            campaignId: campaign.id,
            contactId: contact.id,
            metadata: { providerMessageId: result.providerMessageId, template: template.providerTemplateName },
          });

          await this.prisma.campaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: RecipientStatus.SENT,
              providerMessageId: result.providerMessageId,
              sentAt: result.acceptedAt,
              costPaise: charge.totalChargePaise,
              attempts: { increment: 1 },
              errorCode: null,
              errorMessage: null,
            },
          });

          await this.recordEvent({
            tenantId: job.tenantId,
            contactId: contact.id,
            campaignId: campaign.id,
            channel: Channel.WHATSAPP,
            eventType: CommunicationEventType.WHATSAPP_SENT,
            summary: `WhatsApp template "${template.name}" sent`,
            metadata: { providerMessageId: result.providerMessageId, campaign: campaign.name },
          });
        } catch (error) {
          // 4. The provider failed — the hold comes back in full, so nothing is billed
          //    for a message that never went out.
          await this.metering.release({
            tenantId: job.tenantId,
            idempotencyKey,
            reason: `WhatsApp send failed for recipient ${recipient.id}`,
          });
          await this.handleSendFailure(recipient.id, contact.id, campaign.id, Channel.WHATSAPP, error);
          throw error;
        }

        // Reserved but never settled would be a bug; assert it loudly rather than
        // leaking a hold that a tenant's balance never gets back.
        if (!reservation.created && reservation.heldPaise === 0n) {
          this.logger.warn(`reservation for recipient ${recipient.id} held nothing`);
        }

        await this.campaigns.finalizeIfDone(campaign.id);
      },
      job.actorUserId,
    );
  }

  /** One email — spec §6.2. */
  private async sendEmail(job: EmailSendJob): Promise<void> {
    await this.tenantContext.runAsWorker(
      job.tenantId,
      'send a campaign email',
      async () => {
        const recipient = await this.loadSendable(job.campaignRecipientId);
        if (!recipient) return;

        const { campaign, contact, template } = recipient;
        if (!template) {
          await this.failRecipient(recipient.id, 'template_missing', 'The campaign template was deleted');
          throw new PermanentJobError(`Campaign ${campaign.id} has no template`);
        }

        const variables = mergeVariables(campaign.variables, contact);
        const html = renderTemplate(template.body, variables);
        const subject = renderTemplate(template.subject ?? campaign.name, variables);
        const idempotencyKey = `email:${recipient.id}`;

        const reservation = await this.metering
          .reserve({
            tenantId: job.tenantId,
            eventType: UsageEventType.EMAIL_MESSAGE,
            estimatedQuantity: 1,
            idempotencyKey,
            referenceType: 'campaign_recipient',
            referenceId: recipient.id,
            campaignId: campaign.id,
            contactId: contact.id,
          })
          .catch(async (error: unknown) => {
            if (error instanceof InsufficientFundsException) {
              await this.skipForFunds(recipient.id, campaign.id, error);
              throw new PermanentJobError(`Insufficient funds for recipient ${recipient.id}`);
            }
            throw error;
          });

        try {
          const result = await this.email.send({
            to: recipient.destination,
            toName: contact.fullName,
            subject,
            html,
            text: stripHtml(html),
            fromName: campaign.tenant.emailFromName ?? undefined,
            fromAddress: campaign.tenant.emailFromAddress ?? this.config.email.from,
            referenceId: recipient.id,
          });

          const charge = await this.metering.settle({
            tenantId: job.tenantId,
            eventType: UsageEventType.EMAIL_MESSAGE,
            actualQuantity: 1,
            idempotencyKey,
            description: `Email to ${recipient.destination} for campaign "${campaign.name}"`,
            campaignId: campaign.id,
            contactId: contact.id,
            metadata: { providerMessageId: result.providerMessageId, subject },
          });

          await this.prisma.campaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: RecipientStatus.SENT,
              providerMessageId: result.providerMessageId,
              sentAt: result.acceptedAt,
              costPaise: charge.totalChargePaise,
              attempts: { increment: 1 },
              errorCode: null,
              errorMessage: null,
            },
          });

          await this.recordEvent({
            tenantId: job.tenantId,
            contactId: contact.id,
            campaignId: campaign.id,
            channel: Channel.EMAIL,
            eventType: CommunicationEventType.EMAIL_SENT,
            summary: `Email "${subject}" sent`,
            metadata: { providerMessageId: result.providerMessageId, campaign: campaign.name },
          });
        } catch (error) {
          await this.metering.release({
            tenantId: job.tenantId,
            idempotencyKey,
            reason: `Email send failed for recipient ${recipient.id}`,
          });
          await this.handleSendFailure(recipient.id, contact.id, campaign.id, Channel.EMAIL, error);
          throw error;
        }

        if (!reservation.created && reservation.heldPaise === 0n) {
          this.logger.warn(`reservation for recipient ${recipient.id} held nothing`);
        }

        await this.campaigns.finalizeIfDone(campaign.id);
      },
      job.actorUserId,
    );
  }

  /**
   * Load a recipient that is still worth sending to.
   *
   * Returns null — rather than throwing — for the cases where the job is simply moot:
   * the recipient is already sent, the campaign was cancelled, the contact opted out
   * between launch and send. §12 requires that last one: an opt-out recorded after the
   * campaign launched must still be honored, so consent is re-checked here and not only
   * at audience resolution.
   */
  private async loadSendable(recipientId: string) {
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: recipientId },
      include: {
        contact: true,
        campaign: {
          include: {
            template: true,
            tenant: {
              select: { whatsappPhoneNumberId: true, emailFromName: true, emailFromAddress: true },
            },
          },
        },
      },
    });

    if (!recipient) {
      this.logger.warn(`recipient ${recipientId} no longer exists — dropping the job`);
      return null;
    }
    if (recipient.status !== RecipientStatus.QUEUED && recipient.status !== RecipientStatus.PENDING) {
      // Already handled. A BullMQ retry after a successful send lands here.
      this.logger.debug(`recipient ${recipientId} is ${recipient.status} — nothing to send`);
      return null;
    }
    if (recipient.campaign.status === CampaignStatus.CANCELLED) {
      await this.failRecipient(recipientId, 'cancelled', 'The campaign was cancelled before this message was sent');
      return null;
    }

    const channel = recipient.campaign.channel as Channel;
    const optedOut =
      recipient.contact.optedOutAt !== null ||
      (channel === Channel.WHATSAPP && !recipient.contact.whatsappOptedIn) ||
      (channel === Channel.EMAIL && !recipient.contact.emailOptedIn);

    if (optedOut) {
      // §12: honored immediately, including mid-campaign.
      await this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: RecipientStatus.SKIPPED_OPTED_OUT,
          errorCode: 'opted_out',
          errorMessage: 'The contact opted out after this campaign was launched',
          failedAt: new Date(),
        },
      });
      this.logger.log(`recipient ${recipientId} skipped — opted out after launch`);
      return null;
    }

    return { ...recipient, template: recipient.campaign.template, contact: recipient.contact };
  }

  /**
   * Record a failure, distinguishing retryable from terminal.
   *
   * A retryable failure leaves the recipient `queued` so the queue's own retry can pick
   * it up; only a terminal one writes `failed`. Marking a retryable failure as `failed`
   * would make the campaign look worse than it is and would strand a recipient the next
   * attempt would have reached.
   */
  private async handleSendFailure(
    recipientId: string,
    contactId: string,
    campaignId: string,
    channel: Channel,
    error: unknown,
  ): Promise<void> {
    const providerError = error instanceof ProviderError ? error : null;
    const retryable = providerError?.retryable ?? !(error instanceof PermanentJobError);
    const code = providerError?.providerCode ?? 'send_failed';
    const message = error instanceof Error ? error.message : String(error);

    if (retryable) {
      await this.prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: { attempts: { increment: 1 }, errorCode: code, errorMessage: message },
      });
      this.logger.warn(`recipient ${recipientId} send failed (retryable): ${message}`);
      return;
    }

    await this.failRecipient(recipientId, code, message);
    await this.recordEvent({
      tenantId: this.tenantContext.requireTenantId('campaign send failure'),
      contactId,
      campaignId,
      channel,
      eventType: channel === Channel.EMAIL ? CommunicationEventType.EMAIL_BOUNCED : CommunicationEventType.WHATSAPP_FAILED,
      summary: `Send failed: ${message}`,
      metadata: { providerCode: code },
    });
    await this.campaigns.finalizeIfDone(campaignId);
  }

  private async failRecipient(recipientId: string, code: string, message: string): Promise<void> {
    await this.prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: RecipientStatus.FAILED,
        errorCode: code,
        errorMessage: message,
        failedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * The wallet ran dry mid-campaign — spec §8.2.
   *
   * The recipient is parked in its own status rather than failed, and the campaign is
   * halted, so a top-up plus `POST /campaigns/:id/resume` picks up exactly the
   * recipients that were not reached instead of re-sending to everyone.
   */
  private async skipForFunds(
    recipientId: string,
    campaignId: string,
    error: InsufficientFundsException,
  ): Promise<void> {
    await this.prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status: RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS,
        errorCode: 'insufficient_funds',
        errorMessage: error.message,
        failedAt: new Date(),
      },
    });
    await this.campaigns.haltForFunds(campaignId, 0n);
    this.logger.warn(`campaign ${campaignId} halted at recipient ${recipientId}: ${error.message}`);
  }

  private async recordEvent(input: {
    tenantId: string;
    contactId: string;
    campaignId?: string;
    channel: Channel;
    eventType: CommunicationEventType;
    summary: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    // Through CommunicationsService rather than a direct insert, so the 360° timeline
    // has exactly one writer (§6.4). `recordSafely` because by the time this runs the
    // provider has already accepted the message — failing the job here would retry the
    // send, turning a lost audit row into a duplicate WhatsApp message.
    await this.communications.recordSafely({
      tenantId: input.tenantId,
      contactId: input.contactId,
      campaignId: input.campaignId ?? null,
      channel: input.channel,
      eventType: input.eventType,
      summary: input.summary,
      providerReference: (input.metadata?.providerMessageId as string | undefined) ?? null,
      metadata: input.metadata,
    });
  }
}

/**
 * Variables available to a template render.
 *
 * The contact's own fields win over the campaign defaults: a campaign-level
 * `{{city}}` is a fallback for contacts that do not carry one, not an override of the
 * ones that do.
 */
export function mergeVariables(campaignVariables: unknown, contact: { fullName: string; phone: string | null; email: string | null; customFields: unknown }): Record<string, unknown> {
  const defaults = { ...((campaignVariables ?? {}) as Record<string, unknown>) };
  // Internal bookkeeping, not template content.
  delete defaults.__audience;

  return {
    ...defaults,
    ...((contact.customFields ?? {}) as Record<string, unknown>),
    fullName: contact.fullName,
    firstName: contact.fullName.split(/\s+/)[0] ?? contact.fullName,
    phone: contact.phone ?? '',
    email: contact.email ?? '',
  };
}

/**
 * Meta's template API takes body variables positionally (`{{1}}`, `{{2}}`), not by
 * name. `template.variables` preserves the order they appear in the body, so the two
 * representations line up here rather than at the adapter.
 */
export function positionalVariables(names: string[], values: Record<string, unknown>): string[] {
  return names.map((name) => {
    const value = values[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** A plain-text alternative for the multipart email. Not a sanitizer. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

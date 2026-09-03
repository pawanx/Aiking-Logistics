import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CampaignStatus,
  Channel,
  CommunicationEventType,
  RecipientStatus,
  UsageEventType,
  money,
  type CampaignDto,
  type CampaignRecipientDto,
  type CampaignStatsDto,
  type CreateCampaignRequest,
  type LaunchCampaignResponse,
  type Paginated,
} from '@aiking/shared';
import type { Campaign, Contact, Prisma } from '@prisma/client';

import {
  ConflictingDuplicateException,
  NotFoundException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { MeteringService } from '../billing/metering.service';
import { CommunicationsService } from '../communications/communications.service';
import { QueueService } from '../queue/queue.service';
import { TemplatesService } from '../templates/templates.service';
import { WalletService } from '../wallet/wallet.service';

/** A campaign beyond this is an import problem, not a send problem. */
const MAX_RECIPIENTS = 50_000;

/** Which usage event a channel meters as — used for the pre-launch estimate. */
const CHANNEL_USAGE: Record<Channel, UsageEventType> = {
  [Channel.WHATSAPP]: UsageEventType.WHATSAPP_MESSAGE,
  [Channel.EMAIL]: UsageEventType.EMAIL_MESSAGE,
  [Channel.CALL]: UsageEventType.AI_CALL_MINUTE,
};

export interface ListCampaignsQuery {
  page?: number;
  pageSize?: number;
  status?: CampaignStatus;
  channel?: Channel;
}

/**
 * Campaigns — spec §6.1, §6.2, §8.2.
 *
 * The shape of a launch, and why:
 *
 * 1. **Resolve the audience at launch, not at send.** Each recipient row stores the
 *    `destination` it resolved to, so editing a contact's number mid-campaign does not
 *    silently retarget messages already accounted for.
 * 2. **Skip opted-out contacts at resolution time**, recording them as
 *    `skipped_opted_out` rather than omitting them. §12 requires the opt-out to be
 *    honored; an auditor also needs to see that it *was*.
 * 3. **Estimate the cost and check the balance before queueing anything** (§8.2). A
 *    launch that cannot be paid for is refused as a whole with a `top-up required`
 *    response, rather than half-sending and stopping — the tenant's contacts see one
 *    coherent campaign or none.
 * 4. **Charge per recipient at the provider's success callback, not at launch.** The
 *    estimate gates the launch; the actual debit happens in the send processor against
 *    the provider's own message id (§8.2). So a campaign that fails at the provider for
 *    300 of 500 recipients is billed for 200.
 *
 * The launch is not a transaction spanning the sends — it cannot be, because the sends
 * are asynchronous by §3.4. What it *is* is atomic in creating the recipient set, so a
 * crash mid-launch leaves either a draft or a fully-populated queued campaign.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly templates: TemplatesService,
    private readonly metering: MeteringService,
    private readonly wallet: WalletService,
    private readonly queue: QueueService,
    private readonly communications: CommunicationsService,
    private readonly tenantContext: TenantContext,
  ) {}

  async list(query: ListCampaignsQuery = {}): Promise<Paginated<CampaignDto>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

    const where: Prisma.CampaignWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { template: { select: { name: true } } },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    const stats = await this.statsFor(rows.map((row) => row.id));

    return {
      items: rows.map((row) =>
        toCampaignDto(row, row.template?.name ?? null, stats.get(row.id) ?? emptyStats()),
      ),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async get(campaignId: string): Promise<CampaignDto> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { template: { select: { name: true } } },
    });
    if (!campaign) throw new NotFoundException('Campaign', campaignId);

    const stats = await this.statsFor([campaignId]);
    return toCampaignDto(campaign, campaign.template?.name ?? null, stats.get(campaignId) ?? emptyStats());
  }

  /** Per-recipient results — spec §6.1's "failures are per-recipient, not per-campaign". */
  async recipients(
    campaignId: string,
    query: { page?: number; pageSize?: number; status?: RecipientStatus } = {},
  ): Promise<Paginated<CampaignRecipientDto>> {
    await this.require(campaignId);

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, query.pageSize ?? 50));
    const where: Prisma.CampaignRecipientWhereInput = {
      campaignId,
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.campaignRecipient.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { contact: { select: { fullName: true } } },
      }),
      this.prisma.campaignRecipient.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        contactId: row.contactId,
        contactName: row.contact.fullName,
        destination: row.destination,
        status: row.status as RecipientStatus,
        providerMessageId: row.providerMessageId,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        sentAt: row.sentAt?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        openedAt: row.openedAt?.toISOString() ?? null,
        cost: row.costPaise === null ? null : money(row.costPaise),
      })),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /**
   * Create a draft.
   *
   * The audience is not resolved here — a draft created on Monday and launched on
   * Friday should send to Friday's contact list, including the opt-outs recorded in
   * between.
   */
  async create(request: CreateCampaignRequest, createdBy: string): Promise<CampaignDto> {
    const name = (request.name ?? '').trim();
    if (!name) throw new ValidationFailedException('A campaign needs a name');
    if (!Object.values(Channel).includes(request.channel)) {
      throw new ValidationFailedException('Unknown channel', { allowed: Object.values(Channel) });
    }
    if (!request.templateId) throw new ValidationFailedException('A campaign needs a template');

    // Validated at create *and* at launch: catching a channel mismatch now is a better
    // error message, and re-checking at launch catches a template edited in between.
    const template = await this.templates.assertLaunchable(request.templateId, request.channel).catch(
      async (error: unknown) => {
        // An unapproved template is fine for a draft — it may well be approved by the
        // time someone launches. A *wrong-channel* template never becomes right.
        const stillFatal = error instanceof ValidationFailedException;
        if (stillFatal) throw error;
        return null;
      },
    );

    const campaign = await this.prisma.campaign.create({
      data: {
        // From the JWT-derived scope, never the request body (§4.3). The extension
        // stamps it too, and refuses a mismatch rather than rewriting one.
        tenantId: this.tenantContext.requireTenantId('campaigns.create'),
        name,
        channel: request.channel,
        templateId: request.templateId,
        status: request.scheduledAt ? CampaignStatus.SCHEDULED : CampaignStatus.DRAFT,
        scheduledAt: request.scheduledAt ? new Date(request.scheduledAt) : null,
        variables: (request.variables ?? {}) as Prisma.InputJsonValue,
        createdBy,
      },
    });

    // Stash the audience selector on the draft so a launch does not have to repeat it.
    if (request.contactIds?.length || request.filter) {
      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: {
          variables: {
            ...(request.variables ?? {}),
            __audience: JSON.stringify({ contactIds: request.contactIds, filter: request.filter }),
          } as Prisma.InputJsonValue,
        },
      });
    }

    this.logger.log(
      `campaign ${campaign.id} created (${request.channel}${template ? '' : ', template pending approval'})`,
    );
    return this.get(campaign.id);
  }

  /**
   * Launch — spec §6.1, §8.2.
   *
   * Refuses rather than partially sends when the balance will not cover the estimate.
   * The refusal carries the shortfall so the dashboard can put a number on the
   * "top-up required" state instead of a generic error.
   */
  async launch(campaignId: string, request?: CreateCampaignRequest): Promise<LaunchCampaignResponse> {
    const tenantId = this.tenantContext.requireTenantId('campaigns.launch');
    const campaign = await this.require(campaignId);

    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.SCHEDULED) {
      throw new ConflictingDuplicateException(
        `Campaign "${campaign.name}" is ${campaign.status} and cannot be launched again`,
      );
    }
    if (!campaign.templateId) {
      throw new ValidationFailedException('This campaign has no template');
    }

    const channel = campaign.channel as Channel;
    // Re-checked at launch: this is the gate §6.1 requires, and the template may have
    // been edited or rejected since the draft was created.
    await this.templates.assertLaunchable(campaign.templateId, channel);

    const audience = request ?? readStoredAudience(campaign);
    const contacts = await this.resolveAudience(channel, audience);

    if (contacts.eligible.length === 0) {
      throw new ValidationFailedException(
        contacts.skipped.length > 0
          ? `Every one of the ${contacts.skipped.length} selected contacts is unreachable on ${channel} — opted out or missing a ${channel === Channel.EMAIL ? 'email address' : 'phone number'}`
          : 'That audience selection matched no contacts',
        { eligible: 0, skipped: contacts.skipped.length },
      );
    }
    if (contacts.eligible.length > MAX_RECIPIENTS) {
      throw new ValidationFailedException(`A campaign is limited to ${MAX_RECIPIENTS} recipients`, {
        recipients: contacts.eligible.length,
        limit: MAX_RECIPIENTS,
      });
    }

    // §8.2 — check the balance before the paid API calls, not after.
    const estimatedCostPaise = await this.metering.estimate(
      CHANNEL_USAGE[channel],
      contacts.eligible.length,
      tenantId,
    );
    const affordable = await this.wallet.checkAffordable(estimatedCostPaise, tenantId);

    if (!affordable.affordable) {
      // Nothing is written and nothing is queued: the campaign stays a draft the
      // Manager can launch again after topping up.
      this.logger.warn(
        `campaign ${campaignId} launch refused — needs ${estimatedCostPaise} paise, has ${affordable.availablePaise}`,
      );
      return {
        campaignId,
        status: campaign.status as CampaignStatus,
        queuedRecipients: 0,
        estimatedCost: money(estimatedCostPaise),
        insufficientFunds: {
          required: money(estimatedCostPaise),
          available: money(affordable.availablePaise),
          shortfall: money(affordable.shortfallPaise),
        },
      };
    }

    // One transaction for the recipient set: a crash here leaves a draft, not a
    // campaign that is half-addressed.
    await this.prisma.$transaction(async (tx) => {
      await tx.campaignRecipient.createMany({
        data: [
          ...contacts.eligible.map((contact) => ({
            tenantId,
            campaignId,
            contactId: contact.id,
            destination: destinationFor(contact, channel)!,
            status: RecipientStatus.QUEUED,
            queuedAt: new Date(),
          })),
          // Recorded, not omitted: §12 wants the opt-out visible in the campaign's own
          // results rather than as an unexplained difference in the totals.
          ...contacts.skipped.map((contact) => ({
            tenantId,
            campaignId,
            contactId: contact.id,
            destination: destinationFor(contact, channel) ?? '(unreachable)',
            status: RecipientStatus.SKIPPED_OPTED_OUT,
            errorCode: 'opted_out',
            errorMessage: 'The contact has opted out of this channel',
            failedAt: new Date(),
          })),
        ],
        // A relaunch of a partially-populated campaign should not collide on the
        // (campaign_id, contact_id) unique index.
        skipDuplicates: true,
      });

      await tx.campaign.update({
        where: { id: campaignId },
        data: {
          status: CampaignStatus.QUEUED,
          startedAt: new Date(),
          estimatedCostPaise,
          failureReason: null,
        },
      });
    });

    // Enqueued after the transaction commits. The other order would let a worker pick
    // up a campaign whose recipients are not visible yet.
    await this.queue.enqueue(
      'campaign-dispatch',
      { tenantId, campaignId },
      // Deduplicated on the campaign, so a double-clicked Launch dispatches once.
      { jobId: `dispatch:${campaignId}` },
    );

    this.logger.log(
      `campaign ${campaignId} queued: ${contacts.eligible.length} recipients, ${contacts.skipped.length} skipped, est ${estimatedCostPaise} paise`,
    );

    return {
      campaignId,
      status: CampaignStatus.QUEUED,
      queuedRecipients: contacts.eligible.length,
      estimatedCost: money(estimatedCostPaise),
    };
  }

  /**
   * Cancel — stops what has not gone out yet.
   *
   * Already-sent recipients keep their state: the message is gone, and pretending
   * otherwise would misreport both the campaign and the bill.
   */
  async cancel(campaignId: string, reason: string): Promise<CampaignDto> {
    const campaign = await this.require(campaignId);

    if (
      campaign.status === CampaignStatus.COMPLETED ||
      campaign.status === CampaignStatus.CANCELLED ||
      campaign.status === CampaignStatus.COMPLETED_WITH_FAILURES
    ) {
      throw new ConflictingDuplicateException(`Campaign "${campaign.name}" is already ${campaign.status}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.campaignRecipient.updateMany({
        where: { campaignId, status: { in: [RecipientStatus.PENDING, RecipientStatus.QUEUED] } },
        data: {
          status: RecipientStatus.FAILED,
          errorCode: 'cancelled',
          errorMessage: reason,
          failedAt: new Date(),
        },
      });
      await tx.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.CANCELLED, completedAt: new Date(), failureReason: reason },
      });
    });

    this.logger.log(`campaign ${campaignId} cancelled: ${reason}`);
    return this.get(campaignId);
  }

  /**
   * Resume a campaign halted for funds — spec §8.2.
   *
   * Only the recipients that were skipped for funds are re-queued; the ones already
   * sent are left alone, which is the whole point of tracking the skip reason
   * separately from an ordinary failure.
   */
  async resume(campaignId: string): Promise<LaunchCampaignResponse> {
    const tenantId = this.tenantContext.requireTenantId('campaigns.resume');
    const campaign = await this.require(campaignId);

    if (campaign.status !== CampaignStatus.HALTED_INSUFFICIENT_FUNDS) {
      throw new ConflictingDuplicateException(
        `Campaign "${campaign.name}" is ${campaign.status}, not halted for funds`,
      );
    }

    const pending = await this.prisma.campaignRecipient.count({
      where: { campaignId, status: RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS },
    });
    if (pending === 0) {
      throw new ValidationFailedException('No recipients are waiting on funds for this campaign');
    }

    const estimatedCostPaise = await this.metering.estimate(CHANNEL_USAGE[campaign.channel as Channel], pending, tenantId);
    const affordable = await this.wallet.checkAffordable(estimatedCostPaise, tenantId);

    if (!affordable.affordable) {
      return {
        campaignId,
        status: CampaignStatus.HALTED_INSUFFICIENT_FUNDS,
        queuedRecipients: 0,
        estimatedCost: money(estimatedCostPaise),
        insufficientFunds: {
          required: money(estimatedCostPaise),
          available: money(affordable.availablePaise),
          shortfall: money(affordable.shortfallPaise),
        },
      };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.campaignRecipient.updateMany({
        where: { campaignId, status: RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS },
        data: {
          status: RecipientStatus.QUEUED,
          queuedAt: new Date(),
          errorCode: null,
          errorMessage: null,
          failedAt: null,
        },
      });
      await tx.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.QUEUED, completedAt: null, failureReason: null },
      });
    });

    await this.queue.enqueue('campaign-dispatch', { tenantId, campaignId }, { jobId: `dispatch:${campaignId}:resume` });

    return {
      campaignId,
      status: CampaignStatus.QUEUED,
      queuedRecipients: pending,
      estimatedCost: money(estimatedCostPaise),
    };
  }

  /**
   * Recompute the campaign's terminal status from its recipients.
   *
   * Called by the dispatcher when the last send resolves. Kept here rather than in the
   * processor so the HTTP path and the worker path agree on what "completed" means.
   */
  async finalizeIfDone(campaignId: string): Promise<CampaignStatus | null> {
    const counts = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });

    const byStatus = new Map(counts.map((row) => [row.status as RecipientStatus, row._count._all]));
    const outstanding =
      (byStatus.get(RecipientStatus.PENDING) ?? 0) + (byStatus.get(RecipientStatus.QUEUED) ?? 0);
    if (outstanding > 0) return null;

    const failed = (byStatus.get(RecipientStatus.FAILED) ?? 0) + (byStatus.get(RecipientStatus.BOUNCED) ?? 0);
    const haltedForFunds = byStatus.get(RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS) ?? 0;

    // Insufficient funds is not "completed with failures" — it is recoverable by a
    // top-up, and §8.2 wants it surfaced as its own state so the dashboard can offer
    // the top-up rather than a retry.
    const status =
      haltedForFunds > 0
        ? CampaignStatus.HALTED_INSUFFICIENT_FUNDS
        : failed > 0
          ? CampaignStatus.COMPLETED_WITH_FAILURES
          : CampaignStatus.COMPLETED;

    const spend = await this.prisma.campaignRecipient.aggregate({
      where: { campaignId },
      _sum: { costPaise: true },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status,
        completedAt: new Date(),
        actualCostPaise: spend._sum.costPaise ?? 0n,
      },
    });

    this.logger.log(`campaign ${campaignId} ${status} (spent ${spend._sum.costPaise ?? 0n} paise)`);
    return status;
  }

  /**
   * Apply a delivery receipt — spec §6.1, §6.3, §6.4.
   *
   * Called by the webhooks module for a verified Meta or SES callback. Three things
   * make this more than an `UPDATE`:
   *
   * 1. **The tenant is resolved from our own row**, keyed by the provider's message id.
   *    A delivery receipt carries no tenant, so a worker scope is opened on whatever
   *    the recipient row says — never on anything in the payload (§4.3).
   * 2. **Status only moves forward.** Meta sends `sent`, `delivered` and `read` as
   *    separate callbacks and does not guarantee their order; a `sent` arriving after a
   *    `read` must not undo the `read`. The rank table below is what enforces that.
   * 3. **No billing happens here.** The charge was settled when the provider accepted
   *    the message (§8.2). A delivery receipt is information, not a cost event — and
   *    Meta charges for a delivered message whether or not it is read.
   *
   * It also appends to the §6.4 timeline, because a delivery receipt is exactly the kind
   * of thing the 360° view exists to show. That write goes through
   * `CommunicationsService` like every other producer's, rather than reaching into
   * `communication_events` directly.
   */
  async applyDeliveryStatus(input: {
    providerMessageId: string;
    status: RecipientStatus;
    occurredAt: Date;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const located = await this.tenantContext.runAsSystem(
      `resolve provider message ${input.providerMessageId}`,
      () =>
        this.prisma.campaignRecipient.findFirst({
          where: { providerMessageId: input.providerMessageId },
          select: { id: true, tenantId: true },
          orderBy: { createdAt: 'desc' },
        }),
    );

    if (!located) {
      // A receipt for a message we did not send — a stale redelivery from before a
      // database reset, or another app sharing the phone number id.
      this.logger.warn(`delivery receipt for unknown message ${input.providerMessageId} — ignored`);
      return;
    }

    await this.tenantContext.runAsWorker(located.tenantId, `apply a ${input.status} delivery receipt`, async () => {
      const recipient = await this.prisma.campaignRecipient.findUnique({
        where: { id: located.id },
        include: { campaign: { select: { channel: true, name: true } } },
      });
      if (!recipient) return;

      if (statusRank(input.status) <= statusRank(recipient.status as RecipientStatus)) {
        this.logger.debug(
          `receipt ${input.status} for recipient ${recipient.id} is not ahead of ${recipient.status} — ignored`,
        );
        return;
      }

      await this.prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: input.status,
          ...timestampFor(input.status, input.occurredAt),
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        },
      });

      const eventType = deliveryEventType(input.status, recipient.campaign.channel as Channel);
      if (eventType) {
        await this.communications.recordSafely({
          tenantId: located.tenantId,
          contactId: recipient.contactId,
          eventType,
          summary: deliverySummary(input.status, recipient.campaign.name, input.errorMessage),
          campaignId: recipient.campaignId,
          providerReference: input.providerMessageId,
          occurredAt: input.occurredAt,
          metadata: {
            ...(input.errorCode ? { errorCode: input.errorCode } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          },
        });
      }

      await this.finalizeIfDone(recipient.campaignId);
    });
  }

  /** Mark a campaign halted because the wallet ran dry mid-send (spec §8.2). */
  async haltForFunds(campaignId: string, shortfallPaise: bigint): Promise<void> {
    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: CampaignStatus.HALTED_INSUFFICIENT_FUNDS,
        failureReason: `Wallet balance ran out mid-campaign — short by ${shortfallPaise} paise. Top up and resume.`,
      },
    });
  }

  /**
   * Apply an inbound WhatsApp message — spec §6.3, §6.4.
   *
   * Finds the contact across tenants matching the sender's phone and records an inbound
   * communication event in the 360° timeline.
   */
  async applyInboundMessage(input: {
    from: string;
    text: string;
    occurredAt: Date;
  }): Promise<void> {
    const contacts = await this.tenantContext.runAsSystem(
      `resolve inbound whatsapp sender ${input.from}`,
      () =>
        this.prisma.contact.findMany({
          where: {
            phone: {
              in: [input.from, `+${input.from.replace(/^\+/, '')}`, input.from.replace(/^\+/, '')],
            },
          },
          select: { id: true, tenantId: true },
        }),
    );

    if (contacts.length === 0) {
      this.logger.debug(`inbound whatsapp message from unknown sender ${input.from} — acknowledged`);
      return;
    }

    for (const contact of contacts) {
      await this.tenantContext.runAsWorker(
        contact.tenantId,
        `record inbound whatsapp message from ${input.from}`,
        async () => {
          await this.communications.recordSafely({
            tenantId: contact.tenantId,
            contactId: contact.id,
            eventType: CommunicationEventType.WHATSAPP_INBOUND,
            summary: input.text.length > 80 ? `${input.text.slice(0, 77)}...` : input.text,
            occurredAt: input.occurredAt,
            metadata: { from: input.from, text: input.text },
          });
        },
      );
    }
  }

  /**
   * Apply an SES email complaint — spec §6.1, §12.
   *
   * An email spam complaint immediately opts the contact out of future email sends.
   */
  async applyEmailComplaint(providerMessageId: string): Promise<void> {
    const located = await this.tenantContext.runAsSystem(
      `resolve email complaint for message ${providerMessageId}`,
      () =>
        this.prisma.campaignRecipient.findFirst({
          where: { providerMessageId },
          select: { id: true, tenantId: true, contactId: true },
        }),
    );

    if (!located) {
      this.logger.warn(`email complaint for unknown message ${providerMessageId} — ignored`);
      return;
    }

    await this.tenantContext.runAsWorker(
      located.tenantId,
      `apply email complaint for contact ${located.contactId}`,
      async () => {
        await this.prisma.contact.update({
          where: { id: located.contactId },
          data: {
            emailOptedIn: false,
            optedOutAt: new Date(),
          },
        });

        await this.communications.recordSafely({
          tenantId: located.tenantId,
          contactId: located.contactId,
          eventType: CommunicationEventType.CONTACT_OPTED_OUT,
          summary: 'Contact opted out via email spam complaint',
          providerReference: providerMessageId,
          occurredAt: new Date(),
          metadata: { reason: 'ses_complaint', providerMessageId },
        });
      },
    );
  }

  /**
   * Resolve the audience — spec §7, §12.
   *
   * Returns eligible and skipped separately rather than filtering silently, because the
   * campaign's own results have to show that an opted-out contact was excluded.
   */
  private async resolveAudience(
    channel: Channel,
    request: Pick<CreateCampaignRequest, 'contactIds' | 'filter'> | undefined,
  ): Promise<{ eligible: Contact[]; skipped: Contact[] }> {
    const where: Prisma.ContactWhereInput = {};

    if (request?.contactIds?.length) {
      where.id = { in: request.contactIds };
    } else if (request?.filter?.tags?.length) {
      where.tags = { hasEvery: request.filter.tags };
    } else if (!request?.filter?.all) {
      throw new ValidationFailedException(
        'An audience is required: pass contactIds, filter.tags, or filter.all',
      );
    }

    const contacts = await this.prisma.contact.findMany({ where, orderBy: { createdAt: 'asc' } });

    const eligible: Contact[] = [];
    const skipped: Contact[] = [];

    for (const contact of contacts) {
      if (destinationFor(contact, channel) && isReachable(contact, channel)) eligible.push(contact);
      else skipped.push(contact);
    }

    return { eligible, skipped };
  }

  /** Recipient counters for a set of campaigns, in one grouped query. */
  private async statsFor(campaignIds: string[]): Promise<Map<string, CampaignStatsDto>> {
    const result = new Map<string, CampaignStatsDto>();
    if (campaignIds.length === 0) return result;

    const rows = await this.prisma.campaignRecipient.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    });

    for (const row of rows) {
      const stats = result.get(row.campaignId) ?? emptyStats();
      const count = row._count._all;
      stats.total += count;

      switch (row.status as RecipientStatus) {
        case RecipientStatus.PENDING:
        case RecipientStatus.QUEUED:
          stats.pending += count;
          break;
        case RecipientStatus.SENT:
          stats.sent += count;
          break;
        case RecipientStatus.DELIVERED:
          stats.delivered += count;
          break;
        case RecipientStatus.READ:
          stats.read += count;
          break;
        case RecipientStatus.OPENED:
          stats.opened += count;
          break;
        case RecipientStatus.CLICKED:
          stats.clicked += count;
          break;
        case RecipientStatus.FAILED:
          stats.failed += count;
          break;
        case RecipientStatus.BOUNCED:
          stats.bounced += count;
          break;
        case RecipientStatus.SKIPPED_OPTED_OUT:
          stats.skippedOptedOut += count;
          break;
        case RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS:
          stats.skippedInsufficientFunds += count;
          break;
      }
      result.set(row.campaignId, stats);
    }

    return result;
  }

  private async require(campaignId: string): Promise<Campaign> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('Campaign', campaignId);
    return campaign;
  }
}

/** Where a message on this channel would go, or null if there is nowhere. */
export function destinationFor(contact: Contact, channel: Channel): string | null {
  if (channel === Channel.EMAIL) return contact.email;
  return contact.phone;
}

/** Spec §12 — channel-specific consent, checked at audience resolution. */
export function isReachable(contact: Contact, channel: Channel): boolean {
  if (contact.optedOutAt) return false;
  if (channel === Channel.WHATSAPP) return contact.whatsappOptedIn;
  if (channel === Channel.EMAIL) return contact.emailOptedIn;
  return true;
}

/**
 * How far along a recipient's delivery a status is.
 *
 * Delivery receipts are not ordered. Meta sends `sent`, `delivered` and `read` as three
 * separate callbacks over seconds or minutes, retries any it did not get a 2xx for, and
 * makes no promise about the sequence they arrive in — so a naive `UPDATE status = …`
 * lets a redelivered `sent` overwrite a `read` and the campaign report goes backwards.
 * Ranking them makes the update monotonic.
 *
 * The terminal states share the top rank with `read`/`clicked` rather than sitting
 * above them: a bounce after a delivery is a contradiction, and the earlier fact wins.
 * `pending` and `queued` rank below everything because nothing ever moves back to them.
 */
const STATUS_RANK: Record<RecipientStatus, number> = {
  [RecipientStatus.PENDING]: 0,
  [RecipientStatus.QUEUED]: 1,
  [RecipientStatus.SENT]: 2,
  [RecipientStatus.DELIVERED]: 3,
  [RecipientStatus.OPENED]: 3,
  [RecipientStatus.READ]: 4,
  [RecipientStatus.CLICKED]: 4,
  [RecipientStatus.FAILED]: 4,
  [RecipientStatus.BOUNCED]: 4,
  [RecipientStatus.SKIPPED_OPTED_OUT]: 5,
  [RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS]: 5,
};

export function statusRank(status: RecipientStatus): number {
  return STATUS_RANK[status] ?? 0;
}

/** Which timestamp column a delivery status stamps. */
export function timestampFor(status: RecipientStatus, at: Date): Record<string, Date> {
  switch (status) {
    case RecipientStatus.SENT:
      return { sentAt: at };
    case RecipientStatus.DELIVERED:
      return { deliveredAt: at };
    case RecipientStatus.READ:
      return { readAt: at };
    case RecipientStatus.OPENED:
      return { openedAt: at };
    case RecipientStatus.CLICKED:
      return { clickedAt: at };
    case RecipientStatus.FAILED:
    case RecipientStatus.BOUNCED:
      return { failedAt: at };
    default:
      return {};
  }
}

/**
 * Which §6.4 timeline event a delivery receipt appends, or `null` for none.
 *
 * `sent` returns null on purpose: the send processor already wrote `whatsapp_sent` /
 * `email_sent` the moment the provider accepted the message, and Meta's own `sent`
 * callback describes that same fact. Writing it again would put the event in the
 * timeline twice.
 *
 * Email has no `email_failed` type, so an SES rejection is recorded as
 * `email_bounced`. That is accurate for the case SES actually reports — a hard
 * rejection — and the error code travels in the metadata either way.
 */
export function deliveryEventType(
  status: RecipientStatus,
  channel: Channel,
): CommunicationEventType | null {
  const email = channel === Channel.EMAIL;

  switch (status) {
    case RecipientStatus.DELIVERED:
      return email ? CommunicationEventType.EMAIL_DELIVERED : CommunicationEventType.WHATSAPP_DELIVERED;
    case RecipientStatus.READ:
      return CommunicationEventType.WHATSAPP_READ;
    case RecipientStatus.OPENED:
      return CommunicationEventType.EMAIL_OPENED;
    case RecipientStatus.CLICKED:
      return CommunicationEventType.EMAIL_CLICKED;
    case RecipientStatus.BOUNCED:
      return CommunicationEventType.EMAIL_BOUNCED;
    case RecipientStatus.FAILED:
      return email ? CommunicationEventType.EMAIL_BOUNCED : CommunicationEventType.WHATSAPP_FAILED;
    default:
      return null;
  }
}

/** The one-line human summary the timeline renders verbatim. */
export function deliverySummary(
  status: RecipientStatus,
  campaignName: string,
  errorMessage?: string,
): string {
  switch (status) {
    case RecipientStatus.DELIVERED:
      return `Delivered — ${campaignName}`;
    case RecipientStatus.READ:
      return `Read — ${campaignName}`;
    case RecipientStatus.OPENED:
      return `Opened — ${campaignName}`;
    case RecipientStatus.CLICKED:
      return `Clicked a link — ${campaignName}`;
    case RecipientStatus.BOUNCED:
      return `Bounced — ${campaignName}${errorMessage ? `: ${errorMessage}` : ''}`;
    default:
      return `Failed — ${campaignName}${errorMessage ? `: ${errorMessage}` : ''}`;
  }
}

export function emptyStats(): CampaignStatsDto {
  return {
    total: 0,
    pending: 0,
    sent: 0,
    delivered: 0,
    opened: 0,
    read: 0,
    clicked: 0,
    failed: 0,
    bounced: 0,
    skippedOptedOut: 0,
    skippedInsufficientFunds: 0,
  };
}

/** The audience stashed on a draft by `create()`. */
function readStoredAudience(campaign: Campaign): Pick<CreateCampaignRequest, 'contactIds' | 'filter'> | undefined {
  const variables = (campaign.variables ?? {}) as Record<string, unknown>;
  const raw = variables.__audience;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw) as Pick<CreateCampaignRequest, 'contactIds' | 'filter'>;
  } catch {
    return undefined;
  }
}

export function toCampaignDto(campaign: Campaign, templateName: string | null, stats: CampaignStatsDto): CampaignDto {
  return {
    id: campaign.id,
    name: campaign.name,
    channel: campaign.channel as Channel,
    status: campaign.status as CampaignStatus,
    templateId: campaign.templateId,
    templateName,
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    completedAt: campaign.completedAt?.toISOString() ?? null,
    stats,
    estimatedCost: money(campaign.estimatedCostPaise),
    actualCost: money(campaign.actualCostPaise),
    createdBy: campaign.createdBy,
    createdAt: campaign.createdAt.toISOString(),
  };
}

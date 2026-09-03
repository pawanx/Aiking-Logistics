import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  COMMUNICATION_EVENT_CHANNEL,
  Channel,
  CommunicationEventType,
  EventDirection,
  type CommunicationEventDto,
  type ContactTimelineDto,
  type Paginated,
} from '@aiking/shared';
import type { CommunicationEvent, Prisma } from '@prisma/client';

import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { ContactsService } from '../contacts/contacts.service';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Which way an event flows, when the caller does not say.
 *
 * Derived from the event type rather than passed in, because the two are not
 * independent: `whatsapp_inbound` is inbound by definition, and an opt-out is neither
 * — nobody sent it, the platform recorded it. Letting a caller supply a direction that
 * contradicts the type is how a timeline ends up with an "outbound inbound reply".
 */
const DEFAULT_EVENT_DIRECTION: Record<CommunicationEventType, EventDirection> = {
  whatsapp_sent: EventDirection.OUTBOUND,
  whatsapp_delivered: EventDirection.OUTBOUND,
  whatsapp_read: EventDirection.OUTBOUND,
  whatsapp_failed: EventDirection.OUTBOUND,
  whatsapp_inbound: EventDirection.INBOUND,
  email_sent: EventDirection.OUTBOUND,
  email_delivered: EventDirection.OUTBOUND,
  email_opened: EventDirection.OUTBOUND,
  email_clicked: EventDirection.OUTBOUND,
  email_bounced: EventDirection.OUTBOUND,
  call_placed: EventDirection.OUTBOUND,
  call_completed: EventDirection.OUTBOUND,
  call_failed: EventDirection.OUTBOUND,
  call_escalated: EventDirection.SYSTEM,
  contact_opted_out: EventDirection.SYSTEM,
  contact_opted_in: EventDirection.SYSTEM,
};

export interface RecordEventInput {
  /** Defaults to the ambient scope. Passed explicitly by queue processors. */
  tenantId?: string;
  contactId: string;
  eventType: CommunicationEventType;
  /** Rendered verbatim in the timeline, so write it for a human. */
  summary: string;
  /** Defaults to the channel the event type belongs to. */
  channel?: Channel;
  /** Defaults to the direction the event type implies. */
  direction?: EventDirection;
  campaignId?: string | null;
  callId?: string | null;
  /** Provider message id / call uuid, so an event traces back to its provider. */
  providerReference?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface TimelineQuery {
  page?: number;
  pageSize?: number;
  channel?: Channel;
}

export interface FeedQuery extends TimelineQuery {
  contactId?: string;
}

/**
 * The 360° timeline — spec §6.4.
 *
 * One table, one writer. Every channel's events land in `communication_events`, which
 * is what makes the unified view a single indexed query rather than three result sets
 * stitched together in the UI. The spec is explicit that this is the point of the
 * table, and the cost of that design is that *every* producer has to write here — a
 * campaign send, a delivery webhook, a call, an opt-out. So `record()` is the only
 * way anything writes an event, and the producers depend on this service rather than
 * reaching for `prisma.communicationEvent` themselves.
 *
 * Reads are append-only by construction: there is no `update` or `delete` here. An
 * event is a statement that something happened at a moment, and editing one would make
 * the timeline a worse record than no timeline at all.
 */
@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly contacts: ContactsService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * Append one event.
   *
   * Deliberately never throws into the caller's critical path — see `recordSafely`
   * for the variant a send uses. This one does throw, because a caller that is
   * *about* to report success to a user should know the timeline write failed.
   */
  async record(input: RecordEventInput): Promise<CommunicationEventDto> {
    const tenantId = input.tenantId ?? this.tenantContext.requireTenantId('communications.record');

    const row = await this.prisma.communicationEvent.create({
      data: {
        tenantId,
        contactId: input.contactId,
        channel: input.channel ?? COMMUNICATION_EVENT_CHANNEL[input.eventType],
        eventType: input.eventType,
        direction: input.direction ?? DEFAULT_EVENT_DIRECTION[input.eventType],
        summary: input.summary,
        campaignId: input.campaignId ?? null,
        callId: input.callId ?? null,
        providerReference: input.providerReference ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      },
    });

    return toCommunicationEventDto(row);
  }

  /**
   * Append an event, swallowing a failure into a warning.
   *
   * For the case where the event describes something that has already irreversibly
   * happened — a WhatsApp message the provider has accepted, a call that connected.
   * Failing the job at that point would retry the *send*, so a lost timeline row would
   * turn into a duplicate message. A missing row in the audit trail is the smaller
   * problem, and it is logged loudly rather than silently.
   */
  async recordSafely(input: RecordEventInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.error(
        `Timeline write failed for ${input.eventType} on contact ${input.contactId}: ${(error as Error).message}`,
      );
    }
  }

  /** Spec §6.4 — one contact, every channel, newest first. */
  async timeline(contactId: string, query: TimelineQuery = {}): Promise<ContactTimelineDto> {
    // Through ContactsService rather than a direct read, so a contact belonging to
    // another tenant 404s here exactly as it does everywhere else.
    const contact = await this.contacts.get(contactId);

    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.CommunicationEventWhereInput = {
      contactId,
      ...(query.channel ? { channel: query.channel } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.communicationEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.communicationEvent.count({ where }),
    ]);

    return {
      contact,
      events: rows.map(toCommunicationEventDto),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /** Tenant-wide activity feed — the dashboard's "recent activity" panel (§8.4, §11.1). */
  async feed(query: FeedQuery = {}): Promise<Paginated<CommunicationEventDto>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_PAGE_SIZE));

    const where: Prisma.CommunicationEventWhereInput = {
      ...(query.contactId ? { contactId: query.contactId } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.communicationEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.communicationEvent.count({ where }),
    ]);

    return {
      items: rows.map(toCommunicationEventDto),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  /**
   * Find the event a provider reference belongs to.
   *
   * Used by the delivery webhooks: Meta reports a status against a message id, and
   * that is the only handle it gives you back.
   */
  async findByProviderReference(providerReference: string): Promise<CommunicationEventDto | null> {
    const row = await this.prisma.communicationEvent.findFirst({
      where: { providerReference },
      orderBy: { occurredAt: 'desc' },
    });
    return row ? toCommunicationEventDto(row) : null;
  }
}

export function toCommunicationEventDto(row: CommunicationEvent): CommunicationEventDto {
  return {
    id: row.id,
    contactId: row.contactId,
    channel: row.channel as Channel,
    eventType: row.eventType as CommunicationEventType,
    direction: row.direction as EventDirection,
    summary: row.summary,
    campaignId: row.campaignId,
    callId: row.callId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    occurredAt: row.occurredAt.toISOString(),
  };
}

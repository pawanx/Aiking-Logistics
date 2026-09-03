import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Channel,
  CommunicationEventType,
  EventDirection,
  type BulkImportContactsRequest,
  type BulkImportContactsResponse,
  type ContactDto,
  type CreateContactRequest,
  type Paginated,
  type UpdateContactRequest,
} from '@aiking/shared';
import type { Contact, Prisma } from '@prisma/client';

import {
  ConflictingDuplicateException,
  NotFoundException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient, isUniqueViolation } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';

/** Columns the importer understands natively; anything else can become a custom field. */
const KNOWN_COLUMNS = new Set([
  'fullname',
  'name',
  'contactname',
  'customername',
  'phone',
  'mobile',
  'phonenumber',
  'mobilenumber',
  'email',
  'emailaddress',
  'tags',
  'whatsappoptedin',
  'emailoptedin',
]);

/** A bulk import beyond this is a job, not a request (spec §7: 5,000 rows limit). */
const MAX_IMPORT_ROWS = 5_000;

export interface ListContactsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  tag?: string;
  /** Only contacts reachable on this channel — used to build a campaign audience. */
  channel?: Channel;
  optedIn?: boolean;
}

/**
 * Contacts — spec §7, §9.3.
 *
 * Two things here are load-bearing beyond ordinary CRUD:
 *
 * 1. **`custom_fields` is a JSON column** (§7), so a logistics tenant's `shipmentRef`
 *    and a retailer's `loyaltyTier` coexist with no per-tenant schema change.
 * 2. **Opt-out is honored at the source** (§12). `optOut()` writes both the flags and a
 *    timeline event, and campaign audience resolution filters on the same flags — so a
 *    contact who opts out is skipped rather than sent-and-logged.
 */
@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tenantContext: TenantContext,
  ) {}

  async list(query: ListContactsQuery = {}): Promise<Paginated<ContactDto>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 25));

    const where: Prisma.ContactWhereInput = {};

    if (query.search?.trim()) {
      const term = query.search.trim();
      where.OR = [
        { fullName: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } },
        { email: { contains: term, mode: 'insensitive' } },
      ];
    }
    if (query.tag) where.tags = { has: query.tag };
    if (query.optedIn === true) where.optedOutAt = null;

    // Channel reachability: a WhatsApp campaign needs a phone *and* an opt-in (§12),
    // an email campaign needs an address and no opt-out.
    if (query.channel === Channel.WHATSAPP) {
      where.phone = { not: null };
      where.whatsappOptedIn = true;
      where.optedOutAt = null;
    } else if (query.channel === Channel.EMAIL) {
      where.email = { not: null };
      where.emailOptedIn = true;
      where.optedOutAt = null;
    } else if (query.channel === Channel.CALL) {
      where.phone = { not: null };
      where.optedOutAt = null;
    }

    const [items, total] = await Promise.all([
      this.prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.contact.count({ where }),
    ]);

    return {
      items: items.map(toContactDto),
      page: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    };
  }

  async get(contactId: string): Promise<ContactDto> {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId } });
    // Null here is either "no such contact" or "another tenant's contact" — the Prisma
    // extension makes those indistinguishable, which is the point (§4.3). A 404 rather
    // than a 403 also declines to confirm that someone else's id exists.
    if (!contact) throw new NotFoundException('Contact', contactId);
    return toContactDto(contact);
  }

  async create(request: CreateContactRequest): Promise<ContactDto> {
    const fullName = (request.fullName ?? '').trim();
    if (!fullName) throw new ValidationFailedException('A contact needs a name');

    const phone = normalizePhone(request.phone);
    const email = request.email?.trim().toLowerCase() || null;

    if (!phone && !email) {
      throw new ValidationFailedException('A contact needs a phone number or an email address');
    }
    if (email && !email.includes('@')) {
      throw new ValidationFailedException('That email address is not valid', { email });
    }

    const contact = await this.prisma.contact
      .create({
        data: {
          // From the JWT-derived scope, never the request body (§4.3).
          tenantId: this.tenantContext.requireTenantId('contacts.create'),
          fullName,
          phone,
          email,
          customFields: (request.customFields ?? {}) as Prisma.InputJsonValue,
          tags: request.tags ?? [],
          whatsappOptedIn: request.whatsappOptedIn ?? false,
          emailOptedIn: request.emailOptedIn ?? true,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictingDuplicateException(
            `A contact with that ${isUniqueViolation(error, 'phone') ? 'phone number' : 'email address'} already exists`,
          );
        }
        throw error;
      });

    return toContactDto(contact);
  }

  async update(contactId: string, request: UpdateContactRequest): Promise<ContactDto> {
    await this.get(contactId);

    const data: Prisma.ContactUpdateInput = {};
    if (request.fullName !== undefined) {
      const fullName = request.fullName.trim();
      if (!fullName) throw new ValidationFailedException('A contact needs a name');
      data.fullName = fullName;
    }
    if (request.phone !== undefined) data.phone = normalizePhone(request.phone);
    if (request.email !== undefined) data.email = request.email?.trim().toLowerCase() || null;
    if (request.customFields !== undefined) data.customFields = request.customFields as Prisma.InputJsonValue;
    if (request.tags !== undefined) data.tags = request.tags;
    if (request.whatsappOptedIn !== undefined) data.whatsappOptedIn = request.whatsappOptedIn;
    if (request.emailOptedIn !== undefined) data.emailOptedIn = request.emailOptedIn;

    if (Object.keys(data).length === 0) {
      throw new ValidationFailedException('No recognised fields were supplied');
    }

    const contact = await this.prisma.contact.update({ where: { id: contactId }, data }).catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new ConflictingDuplicateException('Another contact already has that phone number or email address');
      }
      throw error;
    });

    return toContactDto(contact);
  }

  async remove(contactId: string): Promise<void> {
    await this.get(contactId);
    await this.prisma.contact.delete({ where: { id: contactId } });
  }

  /**
   * Record an opt-out — spec §12 "opt-out honored immediately".
   *
   * Both channel flags are cleared and `opted_out_at` is stamped, so a request that
   * arrives mid-campaign takes effect on the next recipient the dispatcher evaluates.
   * A timeline event is written because an opt-out is exactly the kind of thing someone
   * later needs to prove was respected.
   */
  async optOut(contactId: string, reason: string, channel: Channel = Channel.WHATSAPP): Promise<ContactDto> {
    const tenantId = this.tenantContext.requireTenantId('contacts.optOut');
    await this.get(contactId);

    const contact = await this.prisma.contact.update({
      where: { id: contactId },
      data: { optedOutAt: new Date(), whatsappOptedIn: false, emailOptedIn: false },
    });

    await this.prisma.communicationEvent.create({
      data: {
        tenantId,
        contactId,
        channel,
        eventType: CommunicationEventType.CONTACT_OPTED_OUT,
        direction: EventDirection.INBOUND,
        summary: `Opted out: ${reason}`,
        metadata: { reason } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(`contact ${contactId} opted out (${reason})`);
    return toContactDto(contact);
  }

  /** Re-subscribe a contact who previously opted out. */
  async optIn(contactId: string, channels: { whatsapp?: boolean; email?: boolean }): Promise<ContactDto> {
    const tenantId = this.tenantContext.requireTenantId('contacts.optIn');
    await this.get(contactId);

    const contact = await this.prisma.contact.update({
      where: { id: contactId },
      data: {
        optedOutAt: null,
        ...(channels.whatsapp !== undefined ? { whatsappOptedIn: channels.whatsapp } : {}),
        ...(channels.email !== undefined ? { emailOptedIn: channels.email } : {}),
      },
    });

    await this.prisma.communicationEvent.create({
      data: {
        tenantId,
        contactId,
        channel: channels.whatsapp ? Channel.WHATSAPP : Channel.EMAIL,
        eventType: CommunicationEventType.CONTACT_OPTED_IN,
        direction: EventDirection.INBOUND,
        summary: 'Opted back in',
      },
    });

    return toContactDto(contact);
  }

  /**
   * CSV bulk import — spec §7.
   *
   * Row-by-row rather than `createMany`, and deliberately so: §7's requirement is that
   * a bad row is reported with its line number, not that the whole file is rejected. A
   * single `createMany` would abort the batch on the first duplicate phone number, which
   * for a 500-row customer list exported from someone else's CRM is the common case
   * rather than the exceptional one.
   *
   * Matching is on phone-then-email, so re-importing an updated export enriches the
   * existing records instead of creating a parallel set.
   */
  async bulkImport(request: BulkImportContactsRequest): Promise<BulkImportContactsResponse> {
    const rows = parseCsv(request.csv ?? '');
    if (rows.length === 0) {
      throw new ValidationFailedException('The CSV contained no data rows');
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ValidationFailedException(`An import is limited to ${MAX_IMPORT_ROWS} rows`, {
        rows: rows.length,
        limit: MAX_IMPORT_ROWS,
      });
    }

    const result: BulkImportContactsResponse = { imported: 0, updated: 0, skipped: 0, errors: [] };
    const asCustomFields = request.unknownColumnsAsCustomFields ?? true;
    // Resolved once for the whole import rather than per row: 5,000 rows should not mean
    // 5,000 context lookups, and every row of one upload lands in one tenant by definition.
    const tenantId = this.tenantContext.requireTenantId('contacts.bulkImport');

    for (const [index, row] of rows.entries()) {
      // +2: one for the header, one because humans count from 1.
      const lineNumber = index + 2;

      try {
        const fullName = (row.fullname ?? row.name ?? row.contactname ?? row.customername ?? '').trim();
        const phone = normalizePhone(row.phone ?? row.mobile ?? row.phonenumber ?? row.mobilenumber);
        const email = (row.email ?? row.emailaddress ?? '').trim().toLowerCase() || null;

        if (!fullName) {
          result.errors.push({ row: lineNumber, message: 'fullName is required' });
          result.skipped += 1;
          continue;
        }
        if (!phone && !email) {
          result.errors.push({ row: lineNumber, message: 'a phone number or email address is required' });
          result.skipped += 1;
          continue;
        }

        const customFields: Record<string, string> = {};
        if (asCustomFields) {
          for (const [key, value] of Object.entries(row)) {
            if (!KNOWN_COLUMNS.has(key) && value !== '') customFields[key] = value;
          }
        }

        const tags = (row.tags ?? '')
          .split(/[;|]/)
          .map((tag) => tag.trim())
          .filter(Boolean);

        // Section 7.1: Match on phone first, then email
        let existing = phone ? await this.prisma.contact.findFirst({ where: { phone } }) : null;
        if (!existing && email) {
          existing = await this.prisma.contact.findFirst({ where: { email } });
        }

        const hasWhatsapp = row.whatsappoptedin !== undefined && row.whatsappoptedin !== '';
        const hasEmail = row.emailoptedin !== undefined && row.emailoptedin !== '';

        if (existing) {
          await this.prisma.contact.update({
            where: { id: existing.id },
            data: {
              fullName,
              phone: phone ?? existing.phone,
              email: email ?? existing.email,
              // Merged, not replaced: a partial export should not wipe fields the
              // tenant maintains in the dashboard.
              customFields: {
                ...(existing.customFields as Record<string, unknown>),
                ...customFields,
              } as Prisma.InputJsonValue,
              tags: Array.from(new Set([...existing.tags, ...tags])),
              ...(hasWhatsapp ? { whatsappOptedIn: parseBoolean(row.whatsappoptedin) } : {}),
              ...(hasEmail ? { emailOptedIn: parseBoolean(row.emailoptedin) } : {}),
            },
          });
          result.updated += 1;
        } else {
          await this.prisma.contact.create({
            data: {
              tenantId,
              fullName,
              phone,
              email,
              customFields: customFields as Prisma.InputJsonValue,
              tags,
              whatsappOptedIn: hasWhatsapp ? parseBoolean(row.whatsappoptedin) : false,
              emailOptedIn: hasEmail ? parseBoolean(row.emailoptedin) : true,
            },
          });
          result.imported += 1;
        }
      } catch (error) {
        result.errors.push({ row: lineNumber, message: (error as Error).message });
        result.skipped += 1;
      }
    }

    this.logger.log(
      `CSV import: ${result.imported} created, ${result.updated} updated, ${result.skipped} skipped`,
    );
    return result;
  }

  /** Distinct tags in use, for the campaign audience picker. */
  async tags(): Promise<Array<{ tag: string; count: number }>> {
    const rows = await this.prisma.contact.findMany({ select: { tags: true } });
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}

export function toContactDto(contact: Contact): ContactDto {
  return {
    id: contact.id,
    fullName: contact.fullName,
    phone: contact.phone,
    email: contact.email,
    customFields: (contact.customFields ?? {}) as Record<string, unknown>,
    whatsappOptedIn: contact.whatsappOptedIn,
    emailOptedIn: contact.emailOptedIn,
    optedOutAt: contact.optedOutAt?.toISOString() ?? null,
    tags: contact.tags,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

/**
 * Normalize an Indian mobile number to E.164.
 *
 * Meta and Plivo both want E.164; a CRM export usually does not supply it. Ten digits
 * are assumed to be Indian because the platform is India-first (§9.1 INR, §12 DPDP),
 * and anything already carrying a `+` is left alone.
 */
export function normalizePhone(input?: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 0) return null;
  return `+${digits}`;
}

function parseBoolean(value: string): boolean {
  return ['true', 'yes', 'y', '1', 'opted_in', 'opted-in'].includes(value.trim().toLowerCase());
}

/**
 * A minimal RFC 4180 CSV reader.
 *
 * Written rather than imported because the requirement is one file format read once at
 * the edge: quoted fields, escaped double quotes, and CRLF. A dependency would carry
 * more surface than the ~40 lines it replaces.
 *
 * Header names are lowercased with non-alphanumerics stripped, so `Full Name`,
 * `full_name` and `fullName` all land on `fullname`.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Skip lines that are entirely empty — trailing newlines are near-universal.
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) pushRow();

  const header = rows.shift();
  if (!header) return [];

  const keys = header.map((name) => name.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));

  return rows.map((values) => {
    const record: Record<string, string> = {};
    keys.forEach((key, columnIndex) => {
      if (key) record[key] = (values[columnIndex] ?? '').trim();
    });
    return record;
  });
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Channel,
  Permission,
  type BulkImportContactsRequest,
  type BulkImportContactsResponse,
  type ContactDto,
  type CreateContactRequest,
  type Paginated,
  type UpdateContactRequest,
} from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { ContactsService } from './contacts.service';

interface OptOutBody {
  reason?: string;
  channel?: string;
}

interface OptInBody {
  whatsapp?: boolean;
  email?: boolean;
}

/**
 * Contacts — spec §7.
 *
 * `contacts:manage` is granted to Manager *and* Staff in §4.2, which is the one place
 * the matrix gives Staff a write permission: they are the people doing the day-to-day
 * customer work. Spending money (campaigns, calls) is where the §4.4 policy gate sits,
 * not here.
 */
@ApiTags('contacts')
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'List contacts, filterable by tag, search term and channel reachability' })
  async list(
    @CurrentUser() principal: RequestPrincipal,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('tag') tag?: string,
    @Query('channel') channel?: string,
    @Query('optedIn') optedIn?: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<Paginated<ContactDto>> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list contacts', () =>
      this.contacts.list({
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        search,
        tag,
        channel: parseChannel(channel),
        optedIn: optedIn === undefined ? undefined : optedIn === 'true',
      }),
    );
  }

  /** Declared before `:contactId` so the literal path is not captured as an id. */
  @Get('tags')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'Tags in use, with counts — for the campaign audience picker' })
  async tags(
    @CurrentUser() principal: RequestPrincipal,
    @Query('tenantId') tenantId?: string,
  ): Promise<Array<{ tag: string; count: number }>> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'list contact tags', () =>
      this.contacts.tags(),
    );
  }

  /**
   * CSV bulk import — spec §7.
   *
   * The body carries the CSV as text rather than multipart. §7's pre-signed-upload flow
   * is Phase 2 in the document, and a JSON body keeps the endpoint driveable from the
   * smoke test and from `curl` without a file on disk.
   */
  @Post('import')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'Bulk import contacts from CSV text (spec §7)' })
  async bulkImport(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: BulkImportContactsRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<BulkImportContactsResponse> {
    if (!body?.csv?.trim()) {
      throw new ValidationFailedException('A `csv` field containing CSV text is required');
    }
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'bulk import contacts', () =>
      this.contacts.bulkImport(body),
    );
  }

  @Post()
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'Create a contact' })
  async create(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: CreateContactRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<ContactDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'create a contact', () =>
      this.contacts.create(body),
    );
  }

  @Get(':contactId')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'One contact' })
  async get(
    @CurrentUser() principal: RequestPrincipal,
    @Param('contactId') contactId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<ContactDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'read a contact', () =>
      this.contacts.get(contactId),
    );
  }

  @Patch(':contactId')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'Update a contact' })
  async update(
    @CurrentUser() principal: RequestPrincipal,
    @Param('contactId') contactId: string,
    @Body() body: UpdateContactRequest,
    @Query('tenantId') tenantId?: string,
  ): Promise<ContactDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'update a contact', () =>
      this.contacts.update(contactId, body),
    );
  }

  /** Spec §12 — an opt-out takes effect immediately and is recorded on the timeline. */
  @Post(':contactId/opt-out')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'Record an opt-out (spec §12)' })
  async optOut(
    @CurrentUser() principal: RequestPrincipal,
    @Param('contactId') contactId: string,
    @Body() body: OptOutBody,
    @Query('tenantId') tenantId?: string,
  ): Promise<ContactDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'opt a contact out', () =>
      this.contacts.optOut(contactId, body.reason?.trim() || 'requested by the contact', parseChannel(body.channel)),
    );
  }

  @Post(':contactId/opt-in')
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'Re-subscribe a contact' })
  async optIn(
    @CurrentUser() principal: RequestPrincipal,
    @Param('contactId') contactId: string,
    @Body() body: OptInBody,
    @Query('tenantId') tenantId?: string,
  ): Promise<ContactDto> {
    return this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'opt a contact in', () =>
      this.contacts.optIn(contactId, { whatsapp: body.whatsapp, email: body.email }),
    );
  }

  @Delete(':contactId')
  @HttpCode(204)
  @RequirePermission(Permission.CONTACTS_MANAGE)
  @ApiOperation({ summary: 'Delete a contact' })
  async remove(
    @CurrentUser() principal: RequestPrincipal,
    @Param('contactId') contactId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<void> {
    await this.tenantAccess.asCaller(principal, tenantId ?? principal.tenantId ?? undefined, 'delete a contact', () =>
      this.contacts.remove(contactId),
    );
  }
}

function parseChannel(value?: string): Channel | undefined {
  if (!value) return undefined;
  const known = Object.values(Channel) as string[];
  if (!known.includes(value)) {
    throw new ValidationFailedException(`Unknown channel "${value}"`, { allowed: known });
  }
  return value as Channel;
}

import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, Role, type InviteUserRequest, type TenantUserDto } from '@aiking/shared';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, RequirePermission } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { TenantAccessService } from '../../common/tenant/tenant-access.service';
import { UsersService, type InviteResult } from './users.service';

interface ChangeRoleBody {
  role?: string;
}

/**
 * Staff within the caller's own tenant — spec §4.2.
 *
 * Every route carries `staff:manage`, which the §4.2 matrix grants to a Manager and to
 * a Super Admin only "(support)" — so a platform session must pass `?tenantId=` and the
 * access is logged by `TenantAccessService`. Staff cannot reach any of it.
 */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Members of your tenant' })
  async list(@CurrentUser() principal: RequestPrincipal): Promise<TenantUserDto[]> {
    return this.tenantAccess.asCaller(principal, principal.tenantId ?? undefined, 'list tenant members', () =>
      this.users.list(),
    );
  }

  @Post()
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Invite a Manager or Staff member (spec §4.2)' })
  async invite(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: InviteUserRequest,
  ): Promise<InviteResult> {
    return this.tenantAccess.asCaller(principal, principal.tenantId ?? undefined, 'invite a tenant member', () =>
      this.users.invite(body, principal.userId),
    );
  }

  @Patch(':membershipId/role')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: "Change a member's role" })
  async changeRole(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
    @Body() body: ChangeRoleBody,
  ): Promise<TenantUserDto> {
    if (body.role !== Role.MANAGER && body.role !== Role.STAFF) {
      throw new ValidationFailedException('role must be "manager" or "staff"');
    }
    const role = body.role;

    return this.tenantAccess.asCaller(principal, principal.tenantId ?? undefined, 'change a member role', () =>
      this.users.changeRole(membershipId, role, principal.userId),
    );
  }

  @Post(':membershipId/reset-password')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Issue a new temporary password for a member' })
  async resetPassword(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
  ): Promise<{ email: string; temporaryPassword: string }> {
    return this.tenantAccess.asCaller(principal, principal.tenantId ?? undefined, 'reset a member password', () =>
      this.users.resetPassword(membershipId),
    );
  }

  /**
   * Revoke a membership. `DELETE` in the HTTP sense, but the row is retained with
   * `revoked_at` set — see `UsersService.revoke`.
   */
  @Delete(':membershipId')
  @RequirePermission(Permission.STAFF_MANAGE)
  @ApiOperation({ summary: 'Revoke a member’s access (spec §4.2 "remove staff")' })
  async revoke(
    @CurrentUser() principal: RequestPrincipal,
    @Param('membershipId') membershipId: string,
  ): Promise<TenantUserDto> {
    return this.tenantAccess.asCaller(principal, principal.tenantId ?? undefined, 'revoke a tenant member', () =>
      this.users.revoke(membershipId, principal.userId),
    );
  }
}

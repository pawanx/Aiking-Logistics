import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InviteStatus, Role, type InviteUserRequest, type TenantUserDto } from '@aiking/shared';

import {
  ConflictingDuplicateException,
  NotFoundException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient, isUniqueViolation } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { AuthService, assertPasswordStrength } from '../auth/auth.service';

export interface InviteResult {
  member: TenantUserDto;
  /** Returned once, only for a newly created account. */
  temporaryPassword?: string;
}

/**
 * Staff management within one tenant — spec §4.2 "Invite / remove staff within own
 * tenant".
 *
 * Every method here operates on the ambient tenant scope, never on a tenant named by
 * the caller. A Manager therefore cannot enumerate or modify another tenant's members
 * even by guessing a membership id: the Prisma extension adds `tenant_id` to the
 * `where` clause, so a foreign id matches nothing.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    private readonly tenantContext: TenantContext,
    private readonly auth: AuthService,
  ) {}

  /** Members of the caller's tenant. */
  async list(): Promise<TenantUserDto[]> {
    const rows = await this.prisma.tenantUser.findMany({
      where: { inviteStatus: { not: InviteStatus.REVOKED } },
      include: { user: true },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(toTenantUserDto);
  }

  /**
   * Invite a Manager or Staff member.
   *
   * `super_admin` is not accepted: it is a flag on `users`, not a tenant role, and
   * granting it from a tenant-scoped endpoint would be a privilege escalation out of
   * the tenant into the platform.
   *
   * The user row is global (§9.3), so an email that already exists gets a *membership*
   * rather than a second account — that is how one person holds a role in two tenants.
   */
  async invite(request: InviteUserRequest, invitedByUserId: string): Promise<InviteResult> {
    const tenantId = this.tenantContext.requireTenantId('users.invite');
    const email = (request.email ?? '').trim().toLowerCase();

    if (!email.includes('@')) {
      throw new ValidationFailedException('A valid email is required', { email });
    }
    if (request.role !== Role.MANAGER && request.role !== Role.STAFF) {
      throw new ValidationFailedException('A tenant member is either a manager or staff', {
        allowed: [Role.MANAGER, Role.STAFF],
      });
    }

    const temporaryPassword = request.password?.trim() || generatePassword();
    assertPasswordStrength(temporaryPassword);

    // Global `users` lookup — deliberately outside the tenant scope, because the point
    // is to find an account that may belong to a different tenant entirely.
    const existing = await this.tenantContext.runAsSystem('look up a global user account by email', () =>
      this.prisma.user.findUnique({
        where: { email },
        include: { tenantUsers: { where: { tenantId } } },
      }),
    );

    if (existing?.tenantUsers.length) {
      const membership = existing.tenantUsers[0]!;

      // A previously revoked member is reinstated rather than duplicated — the UNIQUE
      // on (tenant_id, user_id) means there is only ever one row to reinstate.
      if (membership.inviteStatus === InviteStatus.REVOKED) {
        const restored = await this.prisma.tenantUser.update({
          where: { id: membership.id },
          data: {
            role: request.role,
            inviteStatus: InviteStatus.INVITED,
            invitedBy: invitedByUserId,
            invitedAt: new Date(),
            revokedAt: null,
            acceptedAt: null,
          },
          include: { user: true },
        });
        this.logger.log(`reinstated ${email} as ${request.role} on tenant ${tenantId}`);
        return { member: toTenantUserDto(restored) };
      }

      throw new ConflictingDuplicateException(`${email} is already a member of this tenant`);
    }

    const userId =
      existing?.id ??
      (
        await this.tenantContext.runAsSystem('create a global user account', async () =>
          this.prisma.user.create({
            data: {
              email,
              fullName: request.fullName?.trim() || email,
              passwordHash: await this.auth.hashPassword(temporaryPassword),
            },
          }),
        )
      ).id;

    const created = await this.prisma.tenantUser
      .create({
        data: { tenantId, userId, role: request.role, inviteStatus: InviteStatus.INVITED, invitedBy: invitedByUserId },
        include: { user: true },
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictingDuplicateException(`${email} is already a member of this tenant`);
        }
        throw error;
      });

    this.logger.log(`invited ${email} as ${request.role} to tenant ${tenantId}`);

    return {
      member: toTenantUserDto(created),
      // Only ever disclosed for an account this call created. An existing user's
      // password is theirs and is not reset by being added to another tenant.
      temporaryPassword: existing ? undefined : temporaryPassword,
    };
  }

  /**
   * Revoke a membership — the spec's "remove staff".
   *
   * The membership row is kept with `revoked_at` set rather than deleted, because
   * `campaigns.created_by` and `wallet_transactions.created_by` point at the user: a
   * hard delete would leave a campaign nobody launched and a debit nobody authorised.
   */
  async revoke(membershipId: string, actorUserId: string): Promise<TenantUserDto> {
    const membership = await this.prisma.tenantUser.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('Tenant member', membershipId);

    if (membership.userId === actorUserId) {
      throw new ValidationFailedException(
        'You cannot revoke your own membership — ask another Manager or the platform Super Admin',
      );
    }

    // Refusing to remove the last Manager is not paternalism: a tenant with no Manager
    // has nobody who can top up the wallet or invite a replacement (§4.2), so the
    // account would need platform intervention to recover.
    if (membership.role === Role.MANAGER) {
      const activeManagers = await this.prisma.tenantUser.count({
        where: { role: Role.MANAGER, inviteStatus: { not: InviteStatus.REVOKED } },
      });
      if (activeManagers <= 1) {
        throw new ValidationFailedException('A tenant must keep at least one Manager');
      }
    }

    const revoked = await this.prisma.tenantUser.update({
      where: { id: membershipId },
      data: { inviteStatus: InviteStatus.REVOKED, revokedAt: new Date() },
      include: { user: true },
    });

    this.logger.warn(`revoked ${membership.user.email} from tenant ${membership.tenantId}`);
    return toTenantUserDto(revoked);
  }

  /** Change a member's role between manager and staff. */
  async changeRole(membershipId: string, role: Role, actorUserId: string): Promise<TenantUserDto> {
    if (role !== Role.MANAGER && role !== Role.STAFF) {
      throw new ValidationFailedException('A tenant member is either a manager or staff');
    }

    const membership = await this.prisma.tenantUser.findUnique({ where: { id: membershipId } });
    if (!membership) throw new NotFoundException('Tenant member', membershipId);

    if (membership.userId === actorUserId && role === Role.STAFF) {
      throw new ValidationFailedException('You cannot demote yourself out of the Manager role');
    }

    if (membership.role === Role.MANAGER && role === Role.STAFF) {
      const activeManagers = await this.prisma.tenantUser.count({
        where: { role: Role.MANAGER, inviteStatus: { not: InviteStatus.REVOKED } },
      });
      if (activeManagers <= 1) {
        throw new ValidationFailedException('A tenant must keep at least one Manager');
      }
    }

    const updated = await this.prisma.tenantUser.update({
      where: { id: membershipId },
      data: { role },
      include: { user: true },
    });

    this.logger.log(`role changed to ${role} for membership ${membershipId}`);
    return toTenantUserDto(updated);
  }

  /** Reset a member's password and return the new one, for a locked-out colleague. */
  async resetPassword(membershipId: string): Promise<{ email: string; temporaryPassword: string }> {
    const membership = await this.prisma.tenantUser.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException('Tenant member', membershipId);

    const temporaryPassword = generatePassword();
    const passwordHash = await this.auth.hashPassword(temporaryPassword);

    await this.tenantContext.runAsSystem('reset a tenant member password', () =>
      this.prisma.user.update({ where: { id: membership.userId }, data: { passwordHash } }),
    );

    this.logger.warn(`password reset issued for ${membership.user.email}`);
    return { email: membership.user.email, temporaryPassword };
  }
}

function toTenantUserDto(row: {
  id: string;
  userId: string;
  role: string;
  inviteStatus: string;
  createdAt: Date;
  user: { email: string; fullName: string; lastLoginAt: Date | null };
}): TenantUserDto {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    fullName: row.user.fullName,
    role: row.role as Role,
    inviteStatus: row.inviteStatus as InviteStatus,
    lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const body = Array.from(randomBytes(16), (byte) => alphabet[byte % alphabet.length]).join('');
  return `Ak${body}7`;
}

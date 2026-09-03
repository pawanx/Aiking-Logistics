import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  Role,
  InviteStatus,
  TenantStatus,
  permissionsFor,
  type AuthenticatedUser,
  type LoginRequest,
  type LoginResponse,
} from '@aiking/shared';
import * as bcrypt from 'bcryptjs';

import { CONFIG, type AppConfig } from '../../config/configuration';
import type { JwtPayload, RequestPrincipal } from '../../common/auth/jwt-payload';
import {
  NotFoundException,
  TenantSuspendedException,
  UnauthorizedException,
  ValidationFailedException,
} from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantSettingsService } from '../../common/tenant/tenant-settings.service';

/** The tenant binding chosen for a session, or none for a platform Super Admin. */
interface SessionScope {
  tenantId: string | null;
  tenantName: string | null;
  role: Role;
}

/**
 * Authentication — spec §4.1 (JWT sessions) and §4.3 (the token carries the tenant).
 *
 * Two decisions here shape the rest of the security model:
 *
 * 1. **The tenant is resolved at login and written into the token.** No endpoint takes
 *    a tenant id from the caller; `TenantGuard` rejects a request that tries. So a
 *    stolen token grants exactly the tenant it was minted for, and cross-tenant access
 *    is not a matter of forgetting a filter.
 * 2. **A Super Admin's token has `tid: null`.** It carries no tenant scope at all, and
 *    reaching tenant data requires an explicit `TenantAccessService.asTenant()` call
 *    that logs the access (§4.2 "allow_as_support"). Platform power is therefore
 *    visible in the logs rather than implicit in a session.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
    private readonly tenantContext: TenantContext,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * Verify credentials and mint a token.
   *
   * Runs unscoped by construction: at login there is no tenant context yet, and
   * `users` is not a tenant-scoped model. The lookup is by email, which is globally
   * unique — one person, one account, however many tenants they belong to.
   */
  async login(request: LoginRequest): Promise<LoginResponse> {
    const email = normalizeEmail(request.email);
    if (!email || !request.password) {
      throw new ValidationFailedException('Email and password are both required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        tenantUsers: {
          where: { inviteStatus: { in: [InviteStatus.ACTIVE, InviteStatus.INVITED] } },
          include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // One failure mode, one message, and the bcrypt comparison still runs on a missing
    // user — so response timing does not disclose whether the email exists.
    const passwordHash = user?.passwordHash ?? decoyHash();
    const passwordMatches = await bcrypt.compare(request.password, passwordHash);

    if (!user || !passwordMatches) {
      this.logger.warn(`failed login for ${email}`);
      throw new UnauthorizedException('Incorrect email or password');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated');
    }

    const scope = this.chooseScope(user, request.tenantSlug);

    // A suspended tenant's users cannot get a session at all — the guard would refuse
    // every subsequent request anyway, and failing at login says why (spec §4.2).
    if (scope.tenantId) {
      const tenant = user.tenantUsers.find((membership) => membership.tenantId === scope.tenantId)?.tenant;
      if (tenant && tenant.status !== TenantStatus.ACTIVE) {
        throw new TenantSuspendedException(tenant.name);
      }
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // First successful login accepts a pending invitation — the invite email flow in
    // §4.1 is out of scope, so "logs in with the issued password" is the acceptance.
    const membership = user.tenantUsers.find((candidate) => candidate.tenantId === scope.tenantId);
    if (membership && membership.inviteStatus === InviteStatus.INVITED) {
      await this.tenantContext.runAsSystem('Accept pending invite on first login', async () => {
        await this.prisma.tenantUser.update({
          where: { id: membership.id },
          data: { inviteStatus: InviteStatus.ACTIVE, acceptedAt: new Date() },
        });
      });
    }

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.fullName,
      role: scope.role,
      tid: scope.tenantId,
      sa: user.isSuperAdmin,
    };

    const accessToken = await this.jwt.signAsync(payload);
    const authenticated = await this.describe({
      userId: user.id,
      email: user.email,
      name: user.fullName,
      role: scope.role,
      tenantId: scope.tenantId,
      isSuperAdmin: user.isSuperAdmin,
    });

    this.logger.log(
      `login ${user.email} as ${scope.role}${scope.tenantId ? ` on tenant ${scope.tenantId}` : ' (platform)'}`,
    );

    return { accessToken, expiresIn: this.config.auth.jwtExpiresIn, user: authenticated };
  }

  /**
   * Re-resolve the caller's identity and permissions.
   *
   * The dashboard calls this on load rather than trusting what it cached, because the
   * §4.4 tenant policy can change under a live session — revoking Staff's campaign
   * right must remove the button without waiting for the token to expire.
   */
  async describe(principal: RequestPrincipal): Promise<AuthenticatedUser> {
    let tenantName: string | null = null;
    let permissions = permissionsFor(principal.role, { actingOnTenant: false });

    if (principal.tenantId) {
      const tenant = await this.tenantSettings.get(principal.tenantId);
      tenantName = tenant?.name ?? null;
      permissions = permissionsFor(principal.role, {
        tenantPolicy: tenant?.settings,
        actingOnTenant: true,
      });
    }

    return {
      userId: principal.userId,
      email: principal.email,
      fullName: principal.name,
      isSuperAdmin: principal.isSuperAdmin,
      tenantId: principal.tenantId,
      tenantName,
      role: principal.role,
      permissions,
    };
  }

  /** Which tenants this account could open a session against. */
  async memberships(userId: string): Promise<Array<{ tenantId: string; tenantName: string; slug: string; role: Role }>> {
    const rows = await this.tenantContext.runAsSystem('list own memberships', () =>
      this.prisma.tenantUser.findMany({
        where: { userId, inviteStatus: { in: [InviteStatus.ACTIVE, InviteStatus.INVITED] } },
        include: { tenant: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return rows.map((row) => ({
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      slug: row.tenant.slug,
      role: row.role as Role,
    }));
  }

  /**
   * Change one's own password. Requires the current one — a stolen token should not
   * be enough to lock the real owner out.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    assertPasswordStrength(newPassword);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User', userId);

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('The current password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.hashPassword(newPassword) },
    });

    this.logger.log(`password changed for ${user.email}`);
  }

  /** Shared by tenant onboarding and staff invitation. */
  async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, this.config.auth.bcryptRounds);
  }

  /**
   * Pick the session's tenant.
   *
   * A Super Admin gets none: platform sessions are unscoped on purpose. Everyone else
   * gets the named tenant, or their earliest active membership.
   */
  private chooseScope(
    user: {
      isSuperAdmin: boolean;
      email: string;
      tenantUsers: Array<{ tenantId: string; role: string; tenant: { name: string; slug: string } }>;
    },
    tenantSlug?: string,
  ): SessionScope {
    if (user.isSuperAdmin) {
      return { tenantId: null, tenantName: null, role: Role.SUPER_ADMIN };
    }

    if (user.tenantUsers.length === 0) {
      // An account with no membership can authenticate but has nothing to authorize.
      // Treated as a credential failure rather than a 403, because from the caller's
      // side there is no usable session either way.
      throw new UnauthorizedException('This account is not a member of any tenant');
    }

    const membership = tenantSlug
      ? user.tenantUsers.find((candidate) => candidate.tenant.slug === tenantSlug)
      : user.tenantUsers[0];

    if (!membership) {
      throw new UnauthorizedException(`This account is not a member of "${tenantSlug}"`);
    }

    return {
      tenantId: membership.tenantId,
      tenantName: membership.tenant.name,
      role: membership.role as Role,
    };
  }
}

/**
 * A valid bcrypt hash of a value nobody knows, compared against when the email does
 * not exist. Keeps the failed-login path's cost the same shape as the real one.
 *
 * Generated rather than hard-coded: `bcrypt.compare` against a malformed hash returns
 * false immediately, which would reintroduce exactly the timing difference this is
 * here to remove. Cost 10 regardless of `BCRYPT_ROUNDS`, so the decoy is never
 * cheaper than a real hash.
 */
let placeholderHash: string | null = null;

function decoyHash(): string {
  placeholderHash ??= bcrypt.hashSync(`no-such-user-${process.pid}`, 10);
  return placeholderHash;
}

function normalizeEmail(email: string): string {
  return (email ?? '').trim().toLowerCase();
}

export function assertPasswordStrength(password: string): void {
  if (!password || password.length < 10) {
    throw new ValidationFailedException('A password must be at least 10 characters', { minimumLength: 10 });
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new ValidationFailedException('A password must contain at least one letter and one digit');
  }
}

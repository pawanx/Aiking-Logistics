import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LowBalanceBehavior,
  Role,
  TenantStatus,
  WalletTransactionType,
  money,
  type MoneyDto,
  type OnboardTenantRequest,
  type OnboardTenantResponse,
  type TenantDto,
  type TenantSettings,
} from '@aiking/shared';
import { InviteStatus as PrismaInviteStatus, type Prisma, type Tenant } from '@prisma/client';

import { CONFIG, type AppConfig } from '../../config/configuration';
import { ConflictingDuplicateException, NotFoundException, ValidationFailedException } from '../../common/errors/app-exception';
import { PRISMA, type ExtendedPrismaClient, isUniqueViolation } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import { TenantSettingsService } from '../../common/tenant/tenant-settings.service';
import { AuthService, assertPasswordStrength } from '../auth/auth.service';
import { WalletService } from '../wallet/wallet.service';

/** Characters allowed in a slug — it appears in URLs and in a Razorpay receipt. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export interface SuspendTenantInput {
  tenantId: string;
  reason: string;
  actorEmail: string;
}

/**
 * Tenant lifecycle — spec §4.2 (Super Admin actions) and §8.3 (onboarding credits).
 *
 * The spec's §3.1 promise is that "onboarding tenant #2 is a configuration exercise,
 * not an engineering one". `onboard()` is that promise made concrete: one call creates
 * the tenant, its first Manager, its wallet, and its free-credit grant, and nothing in
 * it is specific to Infinity Fleet.
 */
@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: ExtendedPrismaClient,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly tenantContext: TenantContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly wallet: WalletService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Create a tenant, its first Manager, and its wallet — spec §4.2, §8.3.
   *
   * Everything up to the wallet row is one transaction: a tenant that exists without a
   * Manager is an account nobody can log into, and a Manager without a tenant is an
   * orphaned credential. The free-credit grant is deliberately *outside* that
   * transaction, because it goes through `WalletService.credit()` which takes its own
   * row lock and writes its own ledger row — reimplementing that inline to save a
   * round trip would mean a second, unaudited path to a balance change.
   */
  async onboard(request: OnboardTenantRequest, actorUserId: string): Promise<OnboardTenantResponse> {
    const name = (request.name ?? '').trim();
    if (!name) throw new ValidationFailedException('A tenant name is required');

    const slug = normalizeSlug(request.slug ?? name);
    if (!SLUG_PATTERN.test(slug)) {
      throw new ValidationFailedException(
        'A slug must be 3–50 characters of lowercase letters, digits and hyphens',
        { slug },
      );
    }

    const managerEmail = (request.managerEmail ?? '').trim().toLowerCase();
    if (!managerEmail.includes('@')) {
      throw new ValidationFailedException('A valid managerEmail is required', { managerEmail });
    }

    // Generated when not supplied, and returned exactly once in the response. There is
    // no invitation email in scope (§4.1), so the Super Admin hands it over out of band.
    const temporaryPassword = request.managerPassword?.trim() || generatePassword();
    assertPasswordStrength(temporaryPassword);
    const passwordHash = await this.auth.hashPassword(temporaryPassword);

    const freeCreditsPaise = request.freeCreditsPaise
      ? BigInt(request.freeCreditsPaise)
      : this.config.billing.onboardingFreeCreditsPaise;
    if (freeCreditsPaise < 0n) {
      throw new ValidationFailedException('freeCreditsPaise cannot be negative');
    }

    const settings = mergeSettings(request.settings);

    // Runs as system: there is no tenant scope yet — this call is what creates one.
    const created = await this.tenantContext.runAsSystem('onboard a new tenant', async () =>
      this.prisma
        .$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: {
              name,
              slug,
              plan: request.plan?.trim() || 'standard',
              contactEmail: request.contactEmail?.trim() || managerEmail,
              status: TenantStatus.ACTIVE,
              staffCanLaunchCampaigns: settings.staffCanLaunchCampaigns,
              staffCanTriggerCalls: settings.staffCanTriggerCalls,
              lowBalanceBehavior: settings.lowBalanceBehavior,
              softLimitPaise: BigInt(settings.softLimitPaise),
              lowBalanceThresholdPaise: BigInt(settings.lowBalanceThresholdPaise),
              emailFromAddress: request.contactEmail?.trim() || null,
              emailFromName: name,
            },
          });

          // An existing account keeps its password: a person who already has a login
          // for tenant A and is added to tenant B should not have it reset under them.
          const existing = await tx.user.findUnique({ where: { email: managerEmail } });
          const manager =
            existing ??
            (await tx.user.create({
              data: { email: managerEmail, passwordHash, fullName: request.managerFullName?.trim() || managerEmail },
            }));

          await tx.tenantUser.create({
            data: {
              tenantId: tenant.id,
              userId: manager.id,
              role: Role.MANAGER,
              inviteStatus: PrismaInviteStatus.invited,
              invitedBy: actorUserId,
            },
          });

          await tx.wallet.create({
            data: { tenantId: tenant.id, currency: this.config.razorpay.currency },
          });

          return { tenant, manager, reusedExistingAccount: existing !== null };
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'slug')) {
            throw new ConflictingDuplicateException(`A tenant with the slug "${slug}" already exists`);
          }
          throw error;
        }),
    );

    let granted: MoneyDto = money(0n);
    if (freeCreditsPaise > 0n) {
      const movement = await this.wallet.credit({
        tenantId: created.tenant.id,
        amountPaise: freeCreditsPaise,
        type: WalletTransactionType.FREE_CREDIT_GRANT,
        description: `Onboarding free credits for ${created.tenant.name}`,
        // One grant per tenant, ever. A retried onboarding cannot double-grant.
        idempotencyKey: `onboarding:${created.tenant.id}`,
        referenceType: 'onboarding',
        referenceId: created.tenant.id,
        createdBy: actorUserId,
      });
      granted = money(movement.totalPaise);
    }

    this.logger.log(
      `onboarded tenant ${created.tenant.name} (${created.tenant.slug}) with manager ${managerEmail} ` +
        `and ${granted.formatted} free credits`,
    );

    return {
      tenant: await this.describe(created.tenant.id),
      manager: {
        id: created.manager.id,
        email: created.manager.email,
        // Suppressed when the account already existed — that password is unchanged and
        // is not ours to disclose.
        temporaryPassword: created.reusedExistingAccount ? undefined : temporaryPassword,
      },
      freeCreditsGranted: granted,
    };
  }

  /**
   * Every tenant with its wallet balance — the §4.2 cross-tenant billing view.
   *
   * `runAsSuperAdmin` is required: the wallet lookup is a tenant-scoped model, so
   * without an explicit unscoped context the extension would refuse the query rather
   * than return other tenants' rows.
   */
  async list(actorEmail: string): Promise<TenantDto[]> {
    return this.tenantContext.runAsSuperAdmin(`list all tenants for ${actorEmail}`, async () => {
      const tenants = await this.prisma.tenant.findMany({
        orderBy: { createdAt: 'asc' },
        include: { wallet: true, _count: { select: { contacts: true } } },
      });

      const topups = await this.prisma.walletTransaction.groupBy({
        by: ['tenantId'],
        where: { type: WalletTransactionType.TOPUP_CREDIT },
        _sum: { amountPaise: true },
        _count: { id: true },
        _max: { createdAt: true },
      });

      const topupMap = new Map(
        topups.map((t) => [
          t.tenantId,
          {
            totalPaise: t._sum.amountPaise ?? 0n,
            count: t._count.id,
            lastRechargeAt: t._max.createdAt ? t._max.createdAt.toISOString() : null,
          },
        ]),
      );

      const freeGrants = await this.prisma.walletTransaction.groupBy({
        by: ['tenantId'],
        where: { type: WalletTransactionType.FREE_CREDIT_GRANT },
        _sum: { amountPaise: true },
      });

      const freeGrantMap = new Map(
        freeGrants.map((g) => [g.tenantId, g._sum.amountPaise ?? 0n]),
      );

      return tenants.map((tenant) => {
        const topupInfo = topupMap.get(tenant.id) ?? { totalPaise: 0n, count: 0, lastRechargeAt: null };
        const totalFreeGrant = freeGrantMap.get(tenant.id) ?? 0n;

        return {
          ...toTenantDto(tenant),
          wallet: tenant.wallet
            ? {
                balance: money(tenant.wallet.balancePaise + tenant.wallet.freeCreditBalancePaise),
                paidBalance: money(tenant.wallet.balancePaise),
                freeCreditBalance: money(tenant.wallet.freeCreditBalancePaise),
                reservedBalance: money(tenant.wallet.reservedPaise),
                availableBalance: money(
                  tenant.wallet.balancePaise + tenant.wallet.freeCreditBalancePaise - tenant.wallet.reservedPaise,
                ),
                totalRecharged: money(topupInfo.totalPaise),
                totalSpent: money(tenant.wallet.lifetimeDebitedPaise),
                totalFreeCreditsGranted: money(totalFreeGrant),
                rechargeCount: topupInfo.count,
                lastRechargeAt: topupInfo.lastRechargeAt,
                lowBalance:
                  tenant.wallet.balancePaise + tenant.wallet.freeCreditBalancePaise < tenant.lowBalanceThresholdPaise,
                updatedAt: tenant.wallet.updatedAt.toISOString(),
              }
            : undefined,
          contactCount: tenant._count.contacts,
        };
      });
    });
  }

  /** One tenant, by id. Unscoped read — `tenants` is keyed by `id`, not `tenant_id`. */
  async describe(tenantId: string): Promise<TenantDto> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: { wallet: true, _count: { select: { contacts: true } } },
    });
    if (!tenant) throw new NotFoundException('Tenant', tenantId);

    const topups = await this.prisma.walletTransaction.aggregate({
      where: { tenantId, type: WalletTransactionType.TOPUP_CREDIT },
      _sum: { amountPaise: true },
      _count: { id: true },
      _max: { createdAt: true },
    });

    const freeGrants = await this.prisma.walletTransaction.aggregate({
      where: { tenantId, type: WalletTransactionType.FREE_CREDIT_GRANT },
      _sum: { amountPaise: true },
    });

    return {
      ...toTenantDto(tenant),
      wallet: tenant.wallet
        ? {
            balance: money(tenant.wallet.balancePaise + tenant.wallet.freeCreditBalancePaise),
            paidBalance: money(tenant.wallet.balancePaise),
            freeCreditBalance: money(tenant.wallet.freeCreditBalancePaise),
            reservedBalance: money(tenant.wallet.reservedPaise),
            availableBalance: money(
              tenant.wallet.balancePaise + tenant.wallet.freeCreditBalancePaise - tenant.wallet.reservedPaise,
            ),
            totalRecharged: money(topups._sum.amountPaise ?? 0n),
            totalSpent: money(tenant.wallet.lifetimeDebitedPaise),
            totalFreeCreditsGranted: money(freeGrants._sum.amountPaise ?? 0n),
            rechargeCount: topups._count.id,
            lastRechargeAt: topups._max.createdAt ? topups._max.createdAt.toISOString() : null,
            lowBalance:
              tenant.wallet.balancePaise + tenant.wallet.freeCreditBalancePaise < tenant.lowBalanceThresholdPaise,
            updatedAt: tenant.wallet.updatedAt.toISOString(),
          }
        : undefined,
      contactCount: tenant._count.contacts,
    };
  }

  /**
   * Suspend a tenant — spec §4.2.
   *
   * Nothing is deleted. `TenantGuard` refuses every request for a suspended tenant and
   * login fails with a reason, so suspension stops activity without touching the
   * tenant's data or their wallet balance.
   */
  async suspend(input: SuspendTenantInput): Promise<TenantDto> {
    const reason = input.reason?.trim();
    if (!reason) {
      throw new ValidationFailedException('A suspension reason is required — it is shown to the tenant');
    }

    const tenant = await this.prisma.tenant.update({
      where: { id: input.tenantId },
      data: { status: TenantStatus.SUSPENDED, suspendedAt: new Date(), suspendedReason: reason },
    });

    this.tenantSettings.invalidate(input.tenantId);
    this.logger.warn(`tenant ${tenant.name} suspended by ${input.actorEmail}: ${reason}`);

    return toTenantDto(tenant);
  }

  async resume(tenantId: string, actorEmail: string): Promise<TenantDto> {
    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.ACTIVE, suspendedAt: null, suspendedReason: null },
    });

    this.tenantSettings.invalidate(tenantId);
    this.logger.log(`tenant ${tenant.name} reactivated by ${actorEmail}`);

    return toTenantDto(tenant);
  }

  /**
   * Update the §4.4 / §5.3 policy settings.
   *
   * These are the spec's two unresolved questions expressed as configuration, so
   * resolving them is this call rather than a code change. The settings cache is
   * invalidated immediately: a Manager revoking Staff's campaign rights expects the
   * next request to be refused, not the one after the TTL expires.
   */
  async updateSettings(tenantId: string, patch: Partial<TenantSettings>, actorEmail: string): Promise<TenantDto> {
    const data: Prisma.TenantUpdateInput = {};

    if (patch.staffCanLaunchCampaigns !== undefined) data.staffCanLaunchCampaigns = patch.staffCanLaunchCampaigns;
    if (patch.staffCanTriggerCalls !== undefined) data.staffCanTriggerCalls = patch.staffCanTriggerCalls;

    if (patch.lowBalanceBehavior !== undefined) {
      if (!Object.values(LowBalanceBehavior).includes(patch.lowBalanceBehavior)) {
        throw new ValidationFailedException('Unknown lowBalanceBehavior', {
          allowed: Object.values(LowBalanceBehavior),
        });
      }
      data.lowBalanceBehavior = patch.lowBalanceBehavior;
    }

    if (patch.softLimitPaise !== undefined) {
      const limit = BigInt(patch.softLimitPaise);
      if (limit < 0n) throw new ValidationFailedException('softLimitPaise cannot be negative');
      data.softLimitPaise = limit;
    }

    if (patch.lowBalanceThresholdPaise !== undefined) {
      const threshold = BigInt(patch.lowBalanceThresholdPaise);
      if (threshold < 0n) throw new ValidationFailedException('lowBalanceThresholdPaise cannot be negative');
      data.lowBalanceThresholdPaise = threshold;
    }

    if (Object.keys(data).length === 0) {
      throw new ValidationFailedException('No recognised settings were supplied');
    }

    const tenant = await this.prisma.tenant.update({ where: { id: tenantId }, data });
    this.tenantSettings.invalidate(tenantId);

    this.logger.log(`settings updated for ${tenant.name} by ${actorEmail}: ${Object.keys(data).join(', ')}`);
    return toTenantDto(tenant);
  }

  /** Update the tenant's own sending identity (spec §6.2). */
  async updateSendingIdentity(
    tenantId: string,
    patch: { emailFromName?: string; emailFromAddress?: string; whatsappPhoneNumberId?: string },
  ): Promise<TenantDto> {
    if (patch.emailFromAddress && !patch.emailFromAddress.includes('@')) {
      throw new ValidationFailedException('emailFromAddress must be an email address');
    }

    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(patch.emailFromName !== undefined ? { emailFromName: patch.emailFromName.trim() || null } : {}),
        ...(patch.emailFromAddress !== undefined
          ? { emailFromAddress: patch.emailFromAddress.trim().toLowerCase() || null }
          : {}),
        ...(patch.whatsappPhoneNumberId !== undefined
          ? { whatsappPhoneNumberId: patch.whatsappPhoneNumberId.trim() || null }
          : {}),
      },
    });

    this.tenantSettings.invalidate(tenantId);
    return toTenantDto(tenant);
  }
}

/** Fill an incoming partial with the restrictive defaults from §4.4 and §5.3. */
function mergeSettings(patch?: Partial<TenantSettings>): TenantSettings {
  return {
    staffCanLaunchCampaigns: patch?.staffCanLaunchCampaigns ?? false,
    staffCanTriggerCalls: patch?.staffCanTriggerCalls ?? false,
    lowBalanceBehavior: patch?.lowBalanceBehavior ?? LowBalanceBehavior.HARD_STOP,
    softLimitPaise: patch?.softLimitPaise ?? '0',
    lowBalanceThresholdPaise: patch?.lowBalanceThresholdPaise ?? '10000',
  };
}

export function toTenantDto(tenant: Tenant): TenantDto {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status as TenantStatus,
    plan: tenant.plan,
    contactEmail: tenant.contactEmail,
    settings: {
      staffCanLaunchCampaigns: tenant.staffCanLaunchCampaigns,
      staffCanTriggerCalls: tenant.staffCanTriggerCalls,
      lowBalanceBehavior: tenant.lowBalanceBehavior as LowBalanceBehavior,
      softLimitPaise: tenant.softLimitPaise.toString(),
      lowBalanceThresholdPaise: tenant.lowBalanceThresholdPaise.toString(),
    },
    createdAt: tenant.createdAt.toISOString(),
  };
}

function normalizeSlug(source: string): string {
  return source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * A password for a generated Manager account.
 *
 * `crypto.randomBytes` rather than `Math.random`, because this value is a live
 * credential for an account that can spend a wallet.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const body = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  // Guarantees the letter-and-digit requirement in assertPasswordStrength regardless
  // of what the random draw happened to produce.
  return `Ak${body}7`;
}

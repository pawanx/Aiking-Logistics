/**
 * API contract types — the shapes crossing the HTTP boundary.
 *
 * The Next.js dashboard imports these so a change to a response shape is a
 * compile error in the UI rather than a runtime surprise.
 *
 * Money is always a `MoneyDto`, never a bare number (spec §9.1).
 */

import type { MoneyDto } from './money';
import type { Permission } from './permissions';
import type { Role } from './roles';
import type {
  BalanceBucket,
  CallDirection,
  CallOutcome,
  CallStatus,
  CampaignStatus,
  Channel,
  CommunicationEventType,
  EventDirection,
  InviteStatus,
  LowBalanceBehavior,
  RecipientStatus,
  TemplateStatus,
  TenantStatus,
  TranscriptSpeaker,
  UsageEventType,
  WalletTransactionType,
} from './enums';

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface LoginRequest {
  email: string;
  password: string;
  /**
   * Which tenant to open the session against.
   *
   * Only needed by a user who belongs to more than one tenant — one email may hold a
   * membership in several (spec §9.3 `tenant_users` is unique per tenant *and* user).
   * Omitted, the earliest active membership is used.
   */
  tenantSlug?: string;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  fullName: string;
  isSuperAdmin: boolean;
  /** Null for a Super Admin's platform-level session (spec §3.1). */
  tenantId: string | null;
  tenantName: string | null;
  role: Role;
  /** Resolved from the matrix + this tenant's §4.4 policy — drives the UI nav. */
  permissions: Permission[];
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: string;
  user: AuthenticatedUser;
}

// ── Tenants (spec §4.2 Super Admin actions) ──────────────────────────────────

/** Resolves the spec's open items (§4.4, §5.3) as per-tenant configuration. */
export interface TenantSettings {
  /** §4.4 open item — defaults to false until the policy is confirmed. */
  staffCanLaunchCampaigns: boolean;
  /** §4.4 open item — defaults to false. */
  staffCanTriggerCalls: boolean;
  /** §5.3 open item — hard-stop or run against a soft limit. */
  lowBalanceBehavior: LowBalanceBehavior;
  /** How far below zero a soft-limit tenant may go, in paise. */
  softLimitPaise: string;
  /** Warn in the dashboard below this balance. */
  lowBalanceThresholdPaise: string;
}

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: string;
  contactEmail: string | null;
  settings: TenantSettings;
  createdAt: string;
  /** Present for Super Admin listings (spec §4.2 cross-tenant billing view). */
  wallet?: WalletSummaryDto;
  contactCount?: number;
}

export interface OnboardTenantRequest {
  name: string;
  slug?: string;
  contactEmail?: string;
  plan?: string;
  /** Manager account created alongside the tenant. */
  managerEmail: string;
  managerFullName: string;
  managerPassword?: string;
  /** Overrides ONBOARDING_FREE_CREDITS_PAISE (spec §8.3). */
  freeCreditsPaise?: string;
  settings?: Partial<TenantSettings>;
}

export interface OnboardTenantResponse {
  tenant: TenantDto;
  manager: { id: string; email: string; temporaryPassword?: string };
  freeCreditsGranted: MoneyDto;
}

// ── Users / staff (spec §4.2 "Invite / remove staff within own tenant") ───────

export interface TenantUserDto {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  role: Role;
  inviteStatus: InviteStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface InviteUserRequest {
  email: string;
  fullName: string;
  role: Extract<Role, 'manager' | 'staff'>;
  password?: string;
}

// ── Contacts (spec §7) ───────────────────────────────────────────────────────

export interface ContactDto {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  /** Spec §7 — flexible per-tenant fields with no schema change. */
  customFields: Record<string, unknown>;
  /** Spec §12 — WhatsApp opt-in captured per contact. */
  whatsappOptedIn: boolean;
  emailOptedIn: boolean;
  optedOutAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactRequest {
  fullName: string;
  phone?: string;
  email?: string;
  customFields?: Record<string, unknown>;
  whatsappOptedIn?: boolean;
  emailOptedIn?: boolean;
  tags?: string[];
}

export type UpdateContactRequest = Partial<CreateContactRequest>;

export interface BulkImportContactsRequest {
  /** Raw CSV text. Header row required; `fullName` is the only mandatory column. */
  csv: string;
  /** Unrecognised columns become customFields entries when true (spec §7). */
  unknownColumnsAsCustomFields?: boolean;
}

export interface BulkImportContactsResponse {
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

// ── Wallet (spec §8) ─────────────────────────────────────────────────────────

/** What a Staff user is allowed to see — spec §8.4 / §4.2 `allow_limited`. */
export interface WalletSummaryDto {
  /** Paid + free, the spendable total. */
  balance: MoneyDto;
  paidBalance: MoneyDto;
  freeCreditBalance: MoneyDto;
  /** Total money recharged / paid top-ups by the tenant (excluding promotional credits) */
  totalRecharged?: MoneyDto;
  /** Total lifetime debited / spent on platform */
  totalSpent?: MoneyDto;
  /** Total promotional free credits granted */
  totalFreeCreditsGranted?: MoneyDto;
  /** Number of top-up recharges completed */
  rechargeCount?: number;
  lastRechargeAt?: string | null;
  /** Currently held by in-flight reservations (spec §15 reserve-then-confirm). */
  reservedBalance: MoneyDto;
  /** balance - reservedBalance. What a new action can actually spend. */
  availableBalance: MoneyDto;
  lowBalance: boolean;
  updatedAt: string;
}

/** Spec §8.4 — Staff get the balance plus a recent-activity summary, no ledger. */
export interface WalletStaffViewDto {
  summary: WalletSummaryDto;
  recentActivity: {
    windowDays: number;
    whatsappMessages: number;
    emails: number;
    aiCallMinutes: number;
    totalSpend: MoneyDto;
  };
}

export interface WalletTransactionDto {
  id: string;
  type: WalletTransactionType;
  bucket: BalanceBucket;
  /** Signed: positive credits, negative debits. */
  amount: MoneyDto;
  balanceAfter: MoneyDto;
  description: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}

/** Spec §8.4 — Managers see the full itemized ledger. */
export interface WalletLedgerDto {
  summary: WalletSummaryDto;
  transactions: WalletTransactionDto[];
  page: PageMeta;
}

// ── Razorpay top-up (spec §8.1) ──────────────────────────────────────────────

export interface CreateTopupRequest {
  /** Integer paise. The spec's initial top-up is ₹5,000 = 500000 paise. */
  amountPaise: string;
  notes?: Record<string, string>;
}

/** Everything the frontend needs to open Razorpay Checkout (spec §8.1 step 2). */
export interface CreateTopupResponse {
  orderId: string;
  razorpayOrderId: string;
  amount: MoneyDto;
  currency: string;
  /** Publishable key id — the secret never leaves the server. */
  keyId: string;
  /** True in mock mode: Checkout is simulated, no real payment page. */
  mock: boolean;
  /** Mock mode only — POST this to /webhooks/razorpay to simulate capture. */
  mockCapturePath?: string;
}

// ── Pricing (spec §9.3 `pricing_rules`, editable without redeploy) ────────────

export interface PricingRuleDto {
  id: string;
  /** Null = platform default, applies to every tenant without an override. */
  tenantId: string | null;
  eventType: UsageEventType;
  unitPrice: MoneyDto;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

// ── Usage (spec §9.3 `usage_events`, immutable billing source) ────────────────

export interface UsageEventDto {
  id: string;
  eventType: UsageEventType;
  quantity: number;
  unitPrice: MoneyDto;
  totalCharge: MoneyDto;
  /** The provider's own reference — the idempotency key (spec §8.2). */
  idempotencyKey: string;
  contactId: string | null;
  campaignId: string | null;
  callId: string | null;
  occurredAt: string;
}

// ── Templates (spec §6.1) ────────────────────────────────────────────────────

export interface TemplateDto {
  id: string;
  name: string;
  channel: Channel;
  status: TemplateStatus;
  language: string;
  subject: string | null;
  body: string;
  /** Placeholder names found in `body`, e.g. ["fullName","shipmentRef"]. */
  variables: string[];
  providerTemplateName: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export interface CreateTemplateRequest {
  name: string;
  channel: Channel;
  language?: string;
  subject?: string;
  body: string;
}

// ── Campaigns (spec §6.1, §6.2) ──────────────────────────────────────────────

export interface CampaignDto {
  id: string;
  name: string;
  channel: Channel;
  status: CampaignStatus;
  templateId: string | null;
  templateName: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Per-recipient counters (spec §6.1 — failures are per-recipient). */
  stats: CampaignStatsDto;
  estimatedCost: MoneyDto;
  actualCost: MoneyDto;
  createdBy: string;
  createdAt: string;
}

export interface CampaignStatsDto {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  opened: number;
  read: number;
  clicked: number;
  failed: number;
  bounced: number;
  skippedOptedOut: number;
  skippedInsufficientFunds: number;
}

export interface CreateCampaignRequest {
  name: string;
  channel: Channel;
  templateId: string;
  /** Explicit recipients; omit to use `filter`. */
  contactIds?: string[];
  filter?: { tags?: string[]; all?: boolean };
  scheduledAt?: string;
  /** Per-campaign variable defaults, merged under each contact's own fields. */
  variables?: Record<string, string>;
}

export interface CampaignRecipientDto {
  id: string;
  contactId: string;
  contactName: string;
  destination: string;
  status: RecipientStatus;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  cost: MoneyDto | null;
}

export interface LaunchCampaignResponse {
  campaignId: string;
  status: CampaignStatus;
  queuedRecipients: number;
  estimatedCost: MoneyDto;
  /** Set when the launch was refused for funds (spec §8.2 "top-up required"). */
  insufficientFunds?: {
    required: MoneyDto;
    available: MoneyDto;
    shortfall: MoneyDto;
  };
}

// ── AI calling (spec §5) ─────────────────────────────────────────────────────

export interface TranscriptTurnDto {
  sequence: number;
  speaker: TranscriptSpeaker;
  text: string;
  /** Deepgram confidence, 0–1, where the provider reports it. */
  confidence: number | null;
  atSeconds: number;
}

export interface CallDto {
  id: string;
  contactId: string;
  contactName: string;
  direction: CallDirection;
  status: CallStatus;
  outcome: CallOutcome | null;
  /** Plivo call UUID — also the metering idempotency key (spec §8.2). */
  providerCallId: string | null;
  fromNumber: string;
  toNumber: string;
  durationSeconds: number;
  billedMinutes: number;
  cost: MoneyDto | null;
  /** Spec §5.1 step 4 — S3 reference, never a public URL. */
  recordingKey: string | null;
  /** Spec §5.1 step 5 — Post-call AI intelligence */
  summary: string | null;
  nextAction: string | null;
  priority: 'urgent' | 'high' | 'medium' | 'low' | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  transcript: TranscriptTurnDto[];
  /** Spec §5.2 — the versioned, reviewed prompt this call ran under. */
  promptVersion: string | null;
  escalatedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface PlaceCallRequest {
  contactId: string;
  /** Which reviewed agent script to run (spec §5.2). */
  scriptId?: string;
  objective?: string;
  metadata?: Record<string, unknown>;
}

// ── 360° timeline (spec §6.4) ────────────────────────────────────────────────

export interface CommunicationEventDto {
  id: string;
  contactId: string;
  channel: Channel;
  eventType: CommunicationEventType;
  direction: EventDirection;
  summary: string;
  campaignId: string | null;
  callId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface ContactTimelineDto {
  contact: ContactDto;
  events: CommunicationEventDto[];
  page: PageMeta;
}

// ── Reports (spec §11.1) ─────────────────────────────────────────────────────

export interface CampaignReportDto {
  campaigns: Array<{
    campaignId: string;
    name: string;
    channel: Channel;
    sent: number;
    delivered: number;
    opened: number;
    failed: number;
    deliveryRate: number;
    openRate: number;
    cost: MoneyDto;
  }>;
  totals: { sent: number; delivered: number; opened: number; failed: number; cost: MoneyDto };
  trend: Array<{ date: string; sent: number; delivered: number; opened: number }>;
}

export interface CallReportDto {
  totalCalls: number;
  completedCalls: number;
  averageDurationSeconds: number;
  totalBilledMinutes: number;
  cost: MoneyDto;
  outcomeDistribution: Array<{ outcome: CallOutcome; count: number }>;
  followUpsPending: number;
  trend: Array<{ date: string; calls: number; minutes: number }>;
}

/** Spec §11.1 / §8.4 — full detail for Managers, summary for Staff. */
export interface UsageReportDto {
  windowStart: string;
  windowEnd: string;
  byChannel: Array<{ channel: Channel; eventType: UsageEventType; quantity: number; spend: MoneyDto }>;
  totalSpend: MoneyDto;
  freeCreditSpend: MoneyDto;
  paidSpend: MoneyDto;
  trend: Array<{ date: string; spend: MoneyDto }>;
}

/** Spec §4.2 — Super Admin only. */
export interface CrossTenantUsageDto {
  tenants: Array<{
    tenantId: string;
    tenantName: string;
    status: TenantStatus;
    balance: MoneyDto;
    spendThisMonth: MoneyDto;
    whatsappMessages: number;
    emails: number;
    aiCallMinutes: number;
  }>;
  platformTotals: { spend: MoneyDto; tenants: number; activeTenants: number };
}

// ── Shared pagination / errors ───────────────────────────────────────────────

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  page: PageMeta;
}

export interface ApiErrorBody {
  statusCode: number;
  /** Stable machine-readable code, e.g. INSUFFICIENT_FUNDS. */
  code: string;
  message: string;
  /**
   * Machine-readable context whose keys depend on `code`.
   *
   * A record rather than a fixed field-error array because the codes carry
   * genuinely different context: `INSUFFICIENT_FUNDS` sends
   * `{ requiredPaise, availablePaise, shortfallPaise }` so the dashboard can name
   * the exact top-up amount (spec §8.2), a validation failure sends
   * `{ issues: string[] }`, and `CROSS_TENANT_ACCESS` sends the reason. Nothing in
   * here is ever an internal message or a stack.
   */
  details?: Record<string, unknown>;
  path: string;
  timestamp: string;
}

/** Stable error codes the dashboard branches on. */
export const ApiErrorCode = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  TOPUP_REQUIRED: 'TOPUP_REQUIRED',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE',
  FORBIDDEN_TENANT_POLICY: 'FORBIDDEN_TENANT_POLICY',
  CROSS_TENANT_ACCESS: 'CROSS_TENANT_ACCESS',
  TEMPLATE_NOT_APPROVED: 'TEMPLATE_NOT_APPROVED',
  CONTACT_OPTED_OUT: 'CONTACT_OPTED_OUT',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL: 'INTERNAL',
} as const;
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

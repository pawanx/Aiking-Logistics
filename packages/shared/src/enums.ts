/**
 * Domain enums shared by the API and the web dashboard.
 *
 * These mirror the Prisma enums in apps/api/prisma/schema.prisma. They are
 * duplicated here rather than imported from the generated Prisma client so the
 * Next.js app does not have to depend on a database client to render a status
 * badge. The `enums-match-prisma` unit test asserts the two stay in step.
 */

// ── Tenants (spec §9.3 `tenants`) ────────────────────────────────────────────

export const TenantStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  PENDING: 'pending',
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

export const InviteStatus = {
  INVITED: 'invited',
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;
export type InviteStatus = (typeof InviteStatus)[keyof typeof InviteStatus];

// ── Channels (spec §6) ───────────────────────────────────────────────────────

export const Channel = {
  WHATSAPP: 'whatsapp',
  EMAIL: 'email',
  CALL: 'call',
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const CHANNEL_LABELS: Record<Channel, string> = {
  [Channel.WHATSAPP]: 'WhatsApp',
  [Channel.EMAIL]: 'Email',
  [Channel.CALL]: 'AI Call',
};

// ── Billing (spec §8.2, §9.3 `pricing_rules` / `usage_events`) ────────────────

/** The metered units. Spec §1.1: per WhatsApp message, per email, per AI-call minute. */
export const UsageEventType = {
  WHATSAPP_MESSAGE: 'whatsapp_message',
  EMAIL_MESSAGE: 'email_message',
  AI_CALL_MINUTE: 'ai_call_minute',
} as const;
export type UsageEventType = (typeof UsageEventType)[keyof typeof UsageEventType];

export const USAGE_EVENT_LABELS: Record<UsageEventType, string> = {
  [UsageEventType.WHATSAPP_MESSAGE]: 'WhatsApp message',
  [UsageEventType.EMAIL_MESSAGE]: 'Email',
  [UsageEventType.AI_CALL_MINUTE]: 'AI call minute',
};

/** Which channel a metered unit belongs to, for spend-by-channel reporting (§11.1). */
export const USAGE_EVENT_CHANNEL: Record<UsageEventType, Channel> = {
  [UsageEventType.WHATSAPP_MESSAGE]: Channel.WHATSAPP,
  [UsageEventType.EMAIL_MESSAGE]: Channel.EMAIL,
  [UsageEventType.AI_CALL_MINUTE]: Channel.CALL,
};

/**
 * Wallet ledger entry types — spec §9.3 `wallet_transactions`, an immutable
 * append-only ledger.
 *
 * Free credits are tracked with their own types so free-funded versus
 * paid-funded usage stays separately reportable (spec §8.3).
 *
 * The ledger records **balance movements only**, which is what makes
 * `sum(amount_paise) === balance_paise + free_credit_balance_paise` an exact,
 * testable invariant. A reserve-then-confirm hold (spec §15) does not move balance —
 * it moves *availability* — so it lives in `wallet_reservations` with its own status
 * and timestamps rather than as a ledger row. The dashboard surfaces it as
 * `reservedBalance`, not as ledger noise.
 */
export const WalletTransactionType = {
  /** Paid credit from a captured Razorpay payment (spec §8.1). */
  TOPUP_CREDIT: 'topup_credit',
  /** Free credits granted at onboarding (spec §8.3). */
  FREE_CREDIT_GRANT: 'free_credit_grant',
  /** Usage debited against paid balance. */
  USAGE_DEBIT: 'usage_debit',
  /** Usage debited against the free-credit balance. */
  FREE_CREDIT_DEBIT: 'free_credit_debit',
  /** Manual correction by a Super Admin — always with a reason. */
  ADJUSTMENT: 'adjustment',
  /** Refund of a previously captured payment. */
  REFUND: 'refund',
} as const;
export type WalletTransactionType = (typeof WalletTransactionType)[keyof typeof WalletTransactionType];

/** Types that increase the tenant's spendable balance. */
export const CREDIT_TYPES: readonly WalletTransactionType[] = [
  WalletTransactionType.TOPUP_CREDIT,
  WalletTransactionType.FREE_CREDIT_GRANT,
];

/** Types that decrease it. */
export const DEBIT_TYPES: readonly WalletTransactionType[] = [
  WalletTransactionType.USAGE_DEBIT,
  WalletTransactionType.FREE_CREDIT_DEBIT,
  WalletTransactionType.REFUND,
];

export const WALLET_TRANSACTION_LABELS: Record<WalletTransactionType, string> = {
  [WalletTransactionType.TOPUP_CREDIT]: 'Wallet top-up',
  [WalletTransactionType.FREE_CREDIT_GRANT]: 'Free credits granted',
  [WalletTransactionType.USAGE_DEBIT]: 'Usage',
  [WalletTransactionType.FREE_CREDIT_DEBIT]: 'Usage (free credits)',
  [WalletTransactionType.ADJUSTMENT]: 'Adjustment',
  [WalletTransactionType.REFUND]: 'Refund',
};

/** Which balance a ledger row moved — needed for §8.3 free-vs-paid reporting. */
export const BalanceBucket = {
  PAID: 'paid',
  FREE: 'free',
} as const;
export type BalanceBucket = (typeof BalanceBucket)[keyof typeof BalanceBucket];

/** Spec §5.3 open item: what happens when a call would overdraw the wallet. */
export const LowBalanceBehavior = {
  /** Refuse the action outright. */
  HARD_STOP: 'hard_stop',
  /** Allow the balance to go negative up to a configured floor. */
  SOFT_LIMIT: 'soft_limit',
} as const;
export type LowBalanceBehavior = (typeof LowBalanceBehavior)[keyof typeof LowBalanceBehavior];

// ── Reservations ─────────────────────────────────────────────────────────────

export const ReservationStatus = {
  HELD: 'held',
  CONFIRMED: 'confirmed',
  RELEASED: 'released',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

// ── Razorpay (spec §8.1, §9.3) ───────────────────────────────────────────────

export const RazorpayOrderStatus = {
  CREATED: 'created',
  ATTEMPTED: 'attempted',
  PAID: 'paid',
  FAILED: 'failed',
} as const;
export type RazorpayOrderStatus = (typeof RazorpayOrderStatus)[keyof typeof RazorpayOrderStatus];

export const RazorpayPaymentStatus = {
  CAPTURED: 'captured',
  AUTHORIZED: 'authorized',
  FAILED: 'failed',
  REFUNDED: 'refunded',
} as const;
export type RazorpayPaymentStatus = (typeof RazorpayPaymentStatus)[keyof typeof RazorpayPaymentStatus];

// ── Campaigns (spec §9.3 `campaigns` / `campaign_recipients`) ─────────────────

export const CampaignStatus = {
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  QUEUED: 'queued',
  SENDING: 'sending',
  COMPLETED: 'completed',
  /** Finished, but at least one recipient terminally failed (spec §6.1). */
  COMPLETED_WITH_FAILURES: 'completed_with_failures',
  /** Halted because the wallet ran dry mid-send (spec §8.2). */
  HALTED_INSUFFICIENT_FUNDS: 'halted_insufficient_funds',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;
export type CampaignStatus = (typeof CampaignStatus)[keyof typeof CampaignStatus];

/**
 * Per-recipient delivery state. Spec §6.1 requires terminal failures be
 * "surfaced per-recipient rather than failing the whole campaign".
 */
export const RecipientStatus = {
  PENDING: 'pending',
  QUEUED: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  OPENED: 'opened',
  CLICKED: 'clicked',
  FAILED: 'failed',
  BOUNCED: 'bounced',
  /** Contact opted out of this channel (spec §12 consent & opt-out). */
  SKIPPED_OPTED_OUT: 'skipped_opted_out',
  /** Wallet had insufficient funds for this recipient (spec §8.2). */
  SKIPPED_INSUFFICIENT_FUNDS: 'skipped_insufficient_funds',
} as const;
export type RecipientStatus = (typeof RecipientStatus)[keyof typeof RecipientStatus];

export const TERMINAL_RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  RecipientStatus.DELIVERED,
  RecipientStatus.READ,
  RecipientStatus.OPENED,
  RecipientStatus.CLICKED,
  RecipientStatus.FAILED,
  RecipientStatus.BOUNCED,
  RecipientStatus.SKIPPED_OPTED_OUT,
  RecipientStatus.SKIPPED_INSUFFICIENT_FUNDS,
];

// ── Templates (spec §6.1 Meta pre-approval workflow) ──────────────────────────

export const TemplateStatus = {
  DRAFT: 'draft',
  /** Submitted to Meta; approval has multi-day external lead time (spec §6.1). */
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAUSED: 'paused',
} as const;
export type TemplateStatus = (typeof TemplateStatus)[keyof typeof TemplateStatus];

// ── AI calling (spec §5) ─────────────────────────────────────────────────────

export const CallDirection = {
  OUTBOUND: 'outbound',
  INBOUND: 'inbound',
} as const;
export type CallDirection = (typeof CallDirection)[keyof typeof CallDirection];

/** Mirrors the five-step pipeline in spec §5.1. */
export const CallStatus = {
  QUEUED: 'queued',
  /** Step 1 — Plivo is placing the call. */
  INITIATED: 'initiated',
  RINGING: 'ringing',
  /** Steps 2–3 — streaming transcription and LLM turns. */
  IN_PROGRESS: 'in_progress',
  /** Step 5 — post-call summarization running. */
  SUMMARIZING: 'summarizing',
  COMPLETED: 'completed',
  NO_ANSWER: 'no_answer',
  BUSY: 'busy',
  FAILED: 'failed',
  /** Spec §5.2 — handed to a human. */
  ESCALATED: 'escalated',
} as const;
export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];

export const CallOutcome = {
  RESOLVED: 'resolved',
  FOLLOW_UP_REQUIRED: 'follow_up_required',
  ESCALATED_TO_HUMAN: 'escalated_to_human',
  NOT_INTERESTED: 'not_interested',
  UNREACHABLE: 'unreachable',
  UNKNOWN: 'unknown',
} as const;
export type CallOutcome = (typeof CallOutcome)[keyof typeof CallOutcome];

export const TranscriptSpeaker = {
  AGENT: 'agent',
  CUSTOMER: 'customer',
  SYSTEM: 'system',
} as const;
export type TranscriptSpeaker = (typeof TranscriptSpeaker)[keyof typeof TranscriptSpeaker];

// ── Unified timeline (spec §6.4 `communication_events`) ───────────────────────

/**
 * Every outbound and inbound event across all three channels lands here, which
 * is what makes the 360° view a single indexed query rather than three stitched
 * together at the UI layer (spec §6.4).
 */
export const CommunicationEventType = {
  WHATSAPP_SENT: 'whatsapp_sent',
  WHATSAPP_DELIVERED: 'whatsapp_delivered',
  WHATSAPP_READ: 'whatsapp_read',
  WHATSAPP_FAILED: 'whatsapp_failed',
  WHATSAPP_INBOUND: 'whatsapp_inbound',
  EMAIL_SENT: 'email_sent',
  EMAIL_DELIVERED: 'email_delivered',
  EMAIL_OPENED: 'email_opened',
  EMAIL_CLICKED: 'email_clicked',
  EMAIL_BOUNCED: 'email_bounced',
  CALL_PLACED: 'call_placed',
  CALL_COMPLETED: 'call_completed',
  CALL_FAILED: 'call_failed',
  CALL_ESCALATED: 'call_escalated',
  CONTACT_OPTED_OUT: 'contact_opted_out',
  CONTACT_OPTED_IN: 'contact_opted_in',
} as const;
export type CommunicationEventType =
  (typeof CommunicationEventType)[keyof typeof CommunicationEventType];

export const COMMUNICATION_EVENT_CHANNEL: Record<CommunicationEventType, Channel> = {
  whatsapp_sent: Channel.WHATSAPP,
  whatsapp_delivered: Channel.WHATSAPP,
  whatsapp_read: Channel.WHATSAPP,
  whatsapp_failed: Channel.WHATSAPP,
  whatsapp_inbound: Channel.WHATSAPP,
  email_sent: Channel.EMAIL,
  email_delivered: Channel.EMAIL,
  email_opened: Channel.EMAIL,
  email_clicked: Channel.EMAIL,
  email_bounced: Channel.EMAIL,
  call_placed: Channel.CALL,
  call_completed: Channel.CALL,
  call_failed: Channel.CALL,
  call_escalated: Channel.CALL,
  contact_opted_out: Channel.WHATSAPP,
  contact_opted_in: Channel.WHATSAPP,
};

export const EventDirection = {
  OUTBOUND: 'outbound',
  INBOUND: 'inbound',
  SYSTEM: 'system',
} as const;
export type EventDirection = (typeof EventDirection)[keyof typeof EventDirection];

// ── Provider layer (spec §1.2, §5 configurable provider layer) ────────────────

export const ProviderMode = {
  MOCK: 'mock',
  LIVE: 'live',
} as const;
export type ProviderMode = (typeof ProviderMode)[keyof typeof ProviderMode];

// ── Queue names (spec §3.4 — async always) ───────────────────────────────────

export const QueueName = {
  WHATSAPP_SEND: 'whatsapp-send',
  EMAIL_SEND: 'email-send',
  CALL_PLACE: 'call-place',
  CALL_SUMMARIZE: 'call-summarize',
  CAMPAIGN_DISPATCH: 'campaign-dispatch',
  /**
   * Delayed callbacks from the mock providers — a delivery receipt, a call
   * completion, a captured payment.
   *
   * These go through the queue rather than a `setTimeout` so `QUEUE_DRIVER=inline`
   * makes them synchronous and ordered in tests. A `setTimeout` would leave timers
   * running after Jest tore the module down, which is how you get a callback firing
   * against a closed database connection.
   */
  PROVIDER_CALLBACK: 'provider-callback',
  /** Fetch a finished recording and run the §5.1 transcribe → summarize chain. */
  RECORDING_INGEST: 'recording-ingest',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QueueName);

import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiErrorCode, type ApiErrorBody } from '@aiking/shared';

/**
 * Domain exceptions with a stable machine-readable `code`.
 *
 * The web app branches on these codes rather than on message text — most
 * importantly `INSUFFICIENT_FUNDS` / `TOPUP_REQUIRED`, which spec §8.2 requires
 * be surfaced as "a clear 'top-up required' state, not a raw provider error".
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: Record<string, unknown>,
  ) {
    super({ code, message, details } satisfies Omit<ApiErrorBody, 'statusCode' | 'path' | 'timestamp'>, status);
  }
}

export class ValidationFailedException extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ApiErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}

export class NotFoundException extends AppException {
  constructor(resource: string, id?: string) {
    super(
      ApiErrorCode.NOT_FOUND,
      id ? `${resource} ${id} was not found` : `${resource} was not found`,
      HttpStatus.NOT_FOUND,
    );
  }
}

export class UnauthorizedException extends AppException {
  constructor(message = 'Authentication is required') {
    super(ApiErrorCode.UNAUTHORIZED, message, HttpStatus.UNAUTHORIZED);
  }
}

/** Role alone is insufficient — spec §4.2. */
export class ForbiddenRoleException extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ApiErrorCode.FORBIDDEN_ROLE, message, HttpStatus.FORBIDDEN, details);
  }
}

/**
 * The role would permit this, but the tenant's own policy does not.
 *
 * This is how spec §4.4's open question ("Can Staff launch campaigns?") is
 * answered without hard-coding an unconfirmed reading: the Manager can flip the
 * setting, and until they do the answer is no.
 */
export class ForbiddenTenantPolicyException extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ApiErrorCode.FORBIDDEN_TENANT_POLICY, message, HttpStatus.FORBIDDEN, details);
  }
}

/** A request tried to reach across tenants — spec §4.3. */
export class CrossTenantAccessException extends AppException {
  constructor(details?: Record<string, unknown>) {
    super(
      ApiErrorCode.CROSS_TENANT_ACCESS,
      'This request refers to a tenant other than the one you are authenticated for',
      HttpStatus.FORBIDDEN,
      details,
    );
  }
}

export class TenantSuspendedException extends AppException {
  constructor(tenantName?: string) {
    super(
      ApiErrorCode.TENANT_SUSPENDED,
      tenantName
        ? `${tenantName} is suspended. Contact Aiking Solutions support.`
        : 'This account is suspended. Contact Aiking Solutions support.',
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Spec §8.2 — the balance check that precedes every paid provider call.
 *
 * `details` carries required / available / shortfall in paise so the UI can say
 * exactly how much to top up.
 */
export class InsufficientFundsException extends AppException {
  constructor(requiredPaise: bigint, availablePaise: bigint, context?: string) {
    const shortfall = requiredPaise - availablePaise;
    super(
      ApiErrorCode.INSUFFICIENT_FUNDS,
      context
        ? `Insufficient wallet balance for ${context}. Top up to continue.`
        : 'Insufficient wallet balance. Top up to continue.',
      HttpStatus.PAYMENT_REQUIRED,
      {
        requiredPaise: requiredPaise.toString(),
        availablePaise: availablePaise.toString(),
        shortfallPaise: (shortfall > 0n ? shortfall : 0n).toString(),
      },
    );
  }
}

/** Meta requires an approved template before a bulk send — spec §6.1. */
export class TemplateNotApprovedException extends AppException {
  constructor(templateName: string, status: string) {
    super(
      ApiErrorCode.TEMPLATE_NOT_APPROVED,
      `Template "${templateName}" is ${status}. WhatsApp requires an approved template for bulk sends.`,
      HttpStatus.CONFLICT,
      { templateName, status },
    );
  }
}

export class ContactOptedOutException extends AppException {
  constructor(channel: string) {
    super(
      ApiErrorCode.CONTACT_OPTED_OUT,
      `This contact has not opted in to ${channel}`,
      HttpStatus.CONFLICT,
      { channel },
    );
  }
}

/** Webhook signature verification failed — spec §12. */
export class InvalidSignatureException extends AppException {
  constructor(provider: string) {
    super(ApiErrorCode.INVALID_SIGNATURE, `${provider} webhook signature verification failed`, HttpStatus.UNAUTHORIZED, {
      provider,
    });
  }
}

/**
 * A distinct exception for a replayed request that could not be resolved to the
 * original result. Note that the *normal* idempotent path does not throw at all:
 * a duplicate Razorpay payment id or usage idempotency key returns the existing
 * record (spec §8.1, §8.2). This is for the case where two different payloads
 * share one key, which is a caller bug.
 */
export class ConflictingDuplicateException extends AppException {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ApiErrorCode.DUPLICATE_REQUEST, message, HttpStatus.CONFLICT, details);
  }
}

/**
 * Money handling — spec §9.1: "Store wallet amounts as integer paise, never
 * floating point."
 *
 * Every monetary value in this codebase is a `bigint` count of paise. There is
 * deliberately no `number`-typed money anywhere: 0.1 + 0.2 !== 0.3 is not an
 * acceptable property for a billing ledger.
 *
 * Formatting goes through BigInt arithmetic rather than converting to a float
 * first, so a large ledger total cannot lose its last paisa to a rounding step.
 */

/** Paise per rupee. */
export const PAISE_PER_RUPEE = 100n;

export const CURRENCY_CODE = 'INR';
export const CURRENCY_SYMBOL = '₹';

/** Wire representation of money. `paise` is a string because JSON has no bigint. */
export interface MoneyDto {
  /** Exact value, integer paise, as a decimal string. Authoritative. */
  readonly paise: string;
  /** Display convenience only — may lose precision above 2^53 paise. */
  readonly rupees: number;
  /** Pre-formatted for display, e.g. "₹5,000.00". */
  readonly formatted: string;
  readonly currency: string;
}

export class MoneyError extends Error {}

/** Coerce a bigint | number | decimal-string into integer paise. */
export function toPaise(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`Amount is not finite: ${value}`);
    if (!Number.isInteger(value)) {
      throw new MoneyError(`Paise must be a whole number, received ${value}. Use rupeesToPaise() for rupee amounts.`);
    }
    return BigInt(value);
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new MoneyError(`Not an integer paise string: "${value}"`);
  return BigInt(trimmed);
}

/**
 * Convert a rupee amount to paise.
 *
 * Accepts a decimal string (preferred — exact) or a number (rounded to the
 * nearest paisa, since a float cannot represent every 2-decimal value exactly).
 */
export function rupeesToPaise(rupees: string | number): bigint {
  if (typeof rupees === 'number') {
    if (!Number.isFinite(rupees)) throw new MoneyError(`Amount is not finite: ${rupees}`);
    return BigInt(Math.round(rupees * 100));
  }

  const trimmed = rupees.trim().replace(/,/g, '');
  const match = /^(-)?(\d*)(?:\.(\d{0,}))?$/.exec(trimmed);
  if (!match || (match[2] === '' && match[3] === undefined)) {
    throw new MoneyError(`Not a valid rupee amount: "${rupees}"`);
  }

  const [, sign, whole = '0', fractionRaw] = match;
  // Pad/truncate to exactly 2 decimal places, rounding the third digit half-up.
  const fraction = (fractionRaw ?? '').padEnd(3, '0');
  let paise = BigInt(whole || '0') * PAISE_PER_RUPEE + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) paise += 1n;

  return sign === '-' ? -paise : paise;
}

/** Display-only. Loses precision above Number.MAX_SAFE_INTEGER paise. */
export function paiseToRupees(paise: bigint): number {
  return Number(paise) / 100;
}

/** Exact decimal string, always two places: 1234567n -> "12345.67". */
export function paiseToDecimalString(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / PAISE_PER_RUPEE;
  const fraction = abs % PAISE_PER_RUPEE;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** "₹5,000.00" — thousands-separated with Indian digit grouping. */
export function formatPaise(paise: bigint, options: { symbol?: boolean } = {}): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = (abs / PAISE_PER_RUPEE).toString();
  const fraction = (abs % PAISE_PER_RUPEE).toString().padStart(2, '0');

  // Indian grouping: last 3 digits, then 2 at a time (12,34,567.89).
  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const head = whole.slice(0, -3);
    const tail = whole.slice(-3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  }

  const symbol = options.symbol === false ? '' : CURRENCY_SYMBOL;
  return `${negative ? '-' : ''}${symbol}${grouped}.${fraction}`;
}

/** Build the wire representation. Use this at every API boundary. */
export function money(paise: bigint | number | string): MoneyDto {
  const exact = toPaise(paise);
  return {
    paise: exact.toString(),
    rupees: paiseToRupees(exact),
    formatted: formatPaise(exact),
    currency: CURRENCY_CODE,
  };
}

/**
 * Billable minutes for an AI call — spec §5.3 meters calls per minute.
 *
 * Rounded UP to the next whole minute, the standard telephony convention: a
 * 61-second call bills 2 minutes. Zero-length calls bill nothing.
 */
export function billableMinutes(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}

/** Sum a list of paise amounts without ever touching a float. */
export function sumPaise(amounts: Iterable<bigint>): bigint {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return total;
}

/** Clamp to zero — a balance should never be rendered negative. */
export function nonNegative(paise: bigint): bigint {
  return paise < 0n ? 0n : paise;
}

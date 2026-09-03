import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/**
 * Converts any `bigint` left in a response into a decimal string.
 *
 * Money is integer paise in `BigInt` columns (spec §9.1), and `JSON.stringify`
 * throws `TypeError: Do not know how to serialize a BigInt` rather than degrading
 * — so a single forgotten conversion is a 500 on an otherwise-correct endpoint.
 *
 * Services are still expected to return `MoneyDto` (paise + formatted rupees) for
 * anything a user reads; this is the backstop that keeps a missed field from
 * taking down the request, and it serializes as a *string* so no precision is
 * lost on the way to a JavaScript client.
 */
@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => convert(value)));
  }
}

function convert(value: unknown, depth = 0): unknown {
  // Guards against a cyclic structure turning into a stack overflow; nothing this
  // API returns is anywhere near this deep.
  if (depth > 32) return value;

  if (typeof value === 'bigint') return value.toString();

  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Date || value instanceof Buffer) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = convert(item, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = convert(item, depth + 1);
    if (next !== item) changed = true;
    result[key] = next;
  }
  return changed ? result : value;
}

import { Inject, Injectable } from '@nestjs/common';

import { CONFIG, type AppConfig } from '../config/configuration';

/**
 * Shared behaviour for the mock provider adapters.
 *
 * Mock mode is not a stub that always succeeds — that would make the test suite
 * agree with a version of reality where WhatsApp never rejects a number and Plivo
 * never drops a call, which is the version the error handling was written for. So
 * the mocks are:
 *
 *   - **deterministic** — seeded from `MOCK_SEED`, so a failing test fails the same
 *     way on the next run and in CI;
 *   - **fallible on demand** — `MOCK_FAILURE_RATE=0.1` makes one call in ten fail,
 *     which is how the reserve/release path (spec §15, "billing a tenant for a
 *     message that then fails at the provider") gets exercised;
 *   - **optionally slow** — `MOCK_LATENCY_MS` puts real elapsed time into a send so
 *     concurrency behaviour is visible rather than serialized by speed.
 *
 * Defaults are 0 and 0, so an ordinary run is fast and always succeeds.
 */

/**
 * mulberry32 — a small, fast PRNG with a 32-bit state.
 *
 * `Math.random()` is deliberately not used: a mock that fails on a different call
 * each run produces a test suite that fails intermittently, which teaches people
 * to re-run rather than to look.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    // FNV-1a over the seed string, so a human-readable seed maps to a 32-bit state.
    let hash = 0x811c9dc5;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    this.state = hash >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  hex(length: number): string {
    let out = '';
    while (out.length < length) out += this.int(16).toString(16);
    return out.slice(0, length);
  }
}

/** Raised by a mock adapter's injected failure, shaped like a provider rejection. */
export class MockProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly providerCode: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MockProviderError';
  }
}

const FAILURE_MODES: readonly { code: string; message: string; retryable: boolean }[] = [
  { code: 'rate_limited', message: 'Rate limit exceeded, retry after backoff', retryable: true },
  { code: 'upstream_timeout', message: 'Upstream provider timed out', retryable: true },
  { code: 'invalid_recipient', message: 'Recipient is not reachable on this channel', retryable: false },
  { code: 'temporary_failure', message: 'Provider reported a temporary failure', retryable: true },
];

@Injectable()
export class MockBehavior {
  private readonly random: SeededRandom;
  private sequence = 0;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.random = new SeededRandom(config.providers.mock.seed);
  }

  /** Monotonic counter, so generated ids are unique within a process. */
  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * Synthetic provider id. Prefixed by provider so a value appearing in a log or a
   * database row is immediately traceable to where it came from.
   */
  id(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${this.random.hex(8)}${this.nextSequence().toString(36)}`;
  }

  /** Simulated network latency. */
  async delay(): Promise<void> {
    const ms = this.config.providers.mock.latencyMs;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Throws a provider-shaped error at the configured rate. */
  maybeFail(provider: string, operation: string): void {
    const rate = this.config.providers.mock.failureRate;
    if (rate <= 0) return;
    if (this.random.next() >= rate) return;

    const mode = this.random.pick(FAILURE_MODES);
    throw new MockProviderError(provider, operation, mode.code, `${provider}.${operation}: ${mode.message}`, mode.retryable);
  }

  /** `delay()` then `maybeFail()`, which is what every mock call does first. */
  async begin(provider: string, operation: string): Promise<void> {
    await this.delay();
    this.maybeFail(provider, operation);
  }

  get rng(): SeededRandom {
    return this.random;
  }
}

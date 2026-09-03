import { Injectable, Logger } from '@nestjs/common';

import type { ProviderCallbackSink } from './callback-sink';

/**
 * Late-bound holder for the callback sink.
 *
 * The mock providers need the sink, and the sink lives in the webhooks module,
 * which needs the providers — a circular module dependency. Rather than reach for
 * `forwardRef`, which makes the cycle work but leaves it in place, the webhooks
 * module registers its implementation here at boot and the mock providers read it
 * when they fire a callback. The dependency becomes one-directional and the
 * ordering is explicit.
 *
 * In live mode nothing registers, `sink` stays undefined, and the mock code paths
 * are simply never reached.
 */
@Injectable()
export class ProviderCallbackRegistry {
  private readonly logger = new Logger(ProviderCallbackRegistry.name);
  private implementation?: ProviderCallbackSink;

  register(sink: ProviderCallbackSink): void {
    this.implementation = sink;
  }

  get sink(): ProviderCallbackSink | undefined {
    return this.implementation;
  }

  /**
   * Fire a callback without letting its failure fail the send.
   *
   * A real provider's webhook arriving late or not at all does not retroactively
   * un-send the message, so a simulated callback must not either — otherwise mock
   * mode would fail in a way live mode cannot, and tests would be chasing a
   * fiction.
   */
  async emit(description: string, fn: (sink: ProviderCallbackSink) => Promise<void>): Promise<void> {
    const sink = this.implementation;
    if (!sink) return;
    try {
      await fn(sink);
    } catch (error) {
      this.logger.warn(`Simulated callback "${description}" failed: ${(error as Error).message}`);
    }
  }

  async drain(): Promise<void> {
    await this.implementation?.drain();
  }
}

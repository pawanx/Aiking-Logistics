import { Global, Logger, Module, type Provider, type Type } from '@nestjs/common';
import { ProviderMode } from '@aiking/shared';

import { CONFIG, type AppConfig } from '../config/configuration';
import { ProviderCallbackRegistry } from './callback-registry';
import { MockBehavior } from './mock-support';
import {
  EMAIL_PROVIDER,
  LLM_PROVIDER,
  PAYMENTS_PROVIDER,
  STORAGE_PROVIDER,
  STT_PROVIDER,
  TELEPHONY_PROVIDER,
  WHATSAPP_PROVIDER,
} from './provider.types';

import { EmailLiveProvider } from './email/email.live';
import { EmailMockProvider } from './email/email.mock';
import { LlmLiveProvider } from './llm/llm.live';
import { LlmMockProvider } from './llm/llm.mock';
import { PaymentsLiveProvider } from './payments/payments.live';
import { PaymentsMockProvider } from './payments/payments.mock';
import { StorageLiveProvider } from './storage/storage.live';
import { StorageMockProvider } from './storage/storage.mock';
import { SttLiveProvider } from './stt/stt.live';
import { SttMockProvider } from './stt/stt.mock';
import { TelephonyLiveProvider } from './telephony/telephony.live';
import { TelephonyMockProvider } from './telephony/telephony.mock';
import { WhatsAppLiveProvider } from './whatsapp/whatsapp.live';
import { WhatsAppMockProvider } from './whatsapp/whatsapp.mock';

/**
 * Provider wiring — spec §1.2's "configurable provider layer".
 *
 * Both adapters of every pair are instantiated; the token resolves to one of them
 * per `config.providers.*`. Instantiating both is deliberate: it means the mock is
 * still injectable by its concrete class, which is how a test drives
 * `simulateCapture()` or reads the WhatsApp outbox while the rest of the app talks to
 * the token. Constructors here do no I/O, so the unused adapter costs nothing.
 *
 * Modes are per-provider, so a partially-credentialed environment works: real
 * Razorpay in test mode against mock WhatsApp, say, while Meta template approval is
 * still pending (§6.1).
 */

interface PairedProvider {
  token: string;
  label: string;
  mode: (config: AppConfig) => ProviderMode;
  live: Type<unknown>;
  mock: Type<unknown>;
}

const PAIRS: readonly PairedProvider[] = [
  { token: WHATSAPP_PROVIDER, label: 'whatsapp', mode: (c) => c.providers.whatsapp, live: WhatsAppLiveProvider, mock: WhatsAppMockProvider },
  { token: EMAIL_PROVIDER, label: 'email', mode: (c) => c.providers.email, live: EmailLiveProvider, mock: EmailMockProvider },
  { token: TELEPHONY_PROVIDER, label: 'telephony', mode: (c) => c.providers.telephony, live: TelephonyLiveProvider, mock: TelephonyMockProvider },
  { token: STT_PROVIDER, label: 'stt', mode: (c) => c.providers.stt, live: SttLiveProvider, mock: SttMockProvider },
  { token: LLM_PROVIDER, label: 'llm', mode: (c) => c.providers.llm, live: LlmLiveProvider, mock: LlmMockProvider },
  { token: PAYMENTS_PROVIDER, label: 'payments', mode: (c) => c.providers.payments, live: PaymentsLiveProvider, mock: PaymentsMockProvider },
  { token: STORAGE_PROVIDER, label: 'storage', mode: (c) => c.providers.storage, live: StorageLiveProvider, mock: StorageMockProvider },
];

const CONCRETE_ADAPTERS: Type<unknown>[] = PAIRS.flatMap((pair) => [pair.live, pair.mock]);

const selectors: Provider[] = PAIRS.map((pair) => ({
  provide: pair.token,
  inject: [CONFIG, pair.live, pair.mock],
  useFactory: (config: AppConfig, live: unknown, mock: unknown) => {
    const mode = pair.mode(config);
    // Logged at boot so nobody has to guess which adapter answered a request when a
    // send silently "worked" in an environment they thought was live.
    new Logger('Providers').log(`${pair.label} → ${mode}`);
    return mode === ProviderMode.LIVE ? live : mock;
  },
}));

@Global()
@Module({
  providers: [MockBehavior, ProviderCallbackRegistry, ...CONCRETE_ADAPTERS, ...selectors],
  exports: [
    MockBehavior,
    ProviderCallbackRegistry,
    ...PAIRS.map((pair) => pair.token),
    // The concrete mocks are exported too, so tests and the mock-only endpoints
    // (`POST /billing/topups/:orderId/mock-capture`) can reach them directly.
    ...CONCRETE_ADAPTERS,
  ],
})
export class ProvidersModule {}

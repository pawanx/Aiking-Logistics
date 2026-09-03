import { ProviderMode } from '@aiking/shared';

/**
 * Typed configuration, loaded once at boot from the environment.
 *
 * Spec §12 requires provider API keys live in AWS Secrets Manager rather than in
 * code or environment files. That is a deployment concern — Secrets Manager
 * injects them as environment variables into the running task — so this module
 * reads the environment and nothing else. It never logs a secret: see
 * `redactedSummary()` at the bottom, which is what boot logging uses.
 */

export type AppRole = 'api' | 'worker' | 'both';

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  isTest: boolean;
  appRole: AppRole;
  api: {
    port: number;
    globalPrefix: string;
    corsOrigins: string[];
    /**
     * Externally reachable origin of this API. Used to build provider callback URLs
     * and signed object links, so it must be what the outside world can actually
     * reach — a tunnel host in local development, the load balancer in production.
     */
    publicBaseUrl: string;
  };
  database: {
    url: string;
    /** Applied to the pg Pool the Prisma driver adapter runs on. */
    poolMax: number;
    statementTimeoutMs: number;
  };
  redis: {
    url: string;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    bcryptRounds: number;
  };
  queue: {
    driver: 'bullmq' | 'inline';
    prefix: string;
    concurrency: number;
  };
  providers: {
    default: ProviderMode;
    whatsapp: ProviderMode;
    email: ProviderMode;
    telephony: ProviderMode;
    stt: ProviderMode;
    llm: ProviderMode;
    payments: ProviderMode;
    storage: ProviderMode;
    mock: {
      failureRate: number;
      latencyMs: number;
      seed: string;
    };
  };
  whatsapp: {
    apiVersion: string;
    phoneNumberId: string;
    accessToken: string;
    businessAccountId: string;
    appSecret: string;
    verifyToken: string;
  };
  email: {
    transport: 'smtp' | 'ses';
    from: string;
    smtp: { host: string; port: number; secure: boolean; user?: string; pass?: string };
    sesRegion: string;
    webhookSecret: string;
  };
  plivo: {
    authId: string;
    authToken: string;
    fromNumber: string;
    callbackBaseUrl: string;
  };
  deepgram: { apiKey: string; model: string };
  gemini: { apiKey: string; model: string; liveEnabled: boolean };
  razorpay: {
    keyId: string;
    keySecret: string;
    webhookSecret: string;
    currency: string;
  };
  storage: {
    bucket: string;
    region: string;
    localDir: string;
    /**
     * Static credentials, when present. On ECS / App Runner (the §3.6 target)
     * these are normally absent and the live adapter resolves a task role from the
     * container credentials endpoint instead.
     */
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    /** Custom endpoint for an S3-compatible store (MinIO in local Docker). */
    endpoint?: string;
    forcePathStyle: boolean;
  };
  billing: {
    whatsappMessagePaise: bigint;
    emailMessagePaise: bigint;
    aiCallMinutePaise: bigint;
    onboardingFreeCreditsPaise: bigint;
  };
  security: {
    enableRls: boolean;
  };
  logging: {
    level: string;
    pretty: boolean;
  };
}

function str(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${key} must be an integer, got "${raw}"`);
  return parsed;
}

function float(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${key} must be a number, got "${raw}"`);
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function bigintPaise(key: string, fallback: bigint): bigint {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`Environment variable ${key} must be integer paise, got "${raw}"`);
  }
  return BigInt(raw.trim());
}

/** Per-provider mode, falling back to PROVIDER_MODE. */
function providerMode(key: string, fallback: ProviderMode): ProviderMode {
  const raw = (process.env[key] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  if (raw !== ProviderMode.MOCK && raw !== ProviderMode.LIVE) {
    throw new Error(`Environment variable ${key} must be 'mock' or 'live', got "${raw}"`);
  }
  return raw;
}

export function loadConfig(): AppConfig {
  const nodeEnv = str('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const defaultProviderMode = providerMode('PROVIDER_MODE', ProviderMode.MOCK);

  const jwtSecret = str('JWT_SECRET', isProduction ? undefined : 'dev-only-insecure-secret-change-me');

  // A weak JWT secret in production would let anyone mint a Super Admin token,
  // so this is a hard boot failure rather than a warning.
  if (isProduction && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
  if (isProduction && jwtSecret.startsWith('dev-only')) {
    throw new Error('JWT_SECRET is still the development placeholder — set a real secret');
  }

  const appRoleRaw = str('APP_ROLE', 'api').toLowerCase();
  if (!['api', 'worker', 'both'].includes(appRoleRaw)) {
    throw new Error(`APP_ROLE must be one of api|worker|both, got "${appRoleRaw}"`);
  }

  const apiPort = int('API_PORT', 3001);
  const publicBaseUrl = str('PUBLIC_BASE_URL', `http://localhost:${apiPort}`).replace(/\/$/, '');

  const queueDriverRaw = str('QUEUE_DRIVER', isTest ? 'inline' : 'bullmq').toLowerCase();
  if (queueDriverRaw !== 'bullmq' && queueDriverRaw !== 'inline') {
    throw new Error(`QUEUE_DRIVER must be 'bullmq' or 'inline', got "${queueDriverRaw}"`);
  }

  const emailTransportRaw = str('EMAIL_TRANSPORT', 'smtp').toLowerCase();
  if (emailTransportRaw !== 'smtp' && emailTransportRaw !== 'ses') {
    throw new Error(`EMAIL_TRANSPORT must be 'smtp' or 'ses', got "${emailTransportRaw}"`);
  }

  return {
    nodeEnv,
    isProduction,
    isTest,
    appRole: appRoleRaw as AppRole,

    api: {
      port: apiPort,
      globalPrefix: str('API_GLOBAL_PREFIX', 'api'),
      corsOrigins: str('CORS_ORIGINS', 'http://localhost:3000')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      publicBaseUrl,
    },

    database: {
      url: str('DATABASE_URL', 'postgresql://aiking:aiking@localhost:5432/aiking?schema=public'),
      poolMax: int('DATABASE_POOL_MAX', 10),
      statementTimeoutMs: int('DATABASE_STATEMENT_TIMEOUT_MS', 15_000),
    },

    redis: {
      url: str('REDIS_URL', 'redis://localhost:6379'),
    },

    auth: {
      jwtSecret,
      jwtExpiresIn: str('JWT_EXPIRES_IN', '12h'),
      // Kept low in tests: bcrypt at cost 10 dominates an e2e suite's runtime.
      bcryptRounds: int('BCRYPT_ROUNDS', isTest ? 4 : 10),
    },

    queue: {
      driver: queueDriverRaw,
      prefix: str('QUEUE_PREFIX', 'aiking'),
      concurrency: int('QUEUE_CONCURRENCY', 5),
    },

    providers: {
      default: defaultProviderMode,
      whatsapp: providerMode('WHATSAPP_MODE', defaultProviderMode),
      email: providerMode('EMAIL_MODE', defaultProviderMode),
      telephony: providerMode('TELEPHONY_MODE', defaultProviderMode),
      stt: providerMode('STT_MODE', defaultProviderMode),
      llm: providerMode('LLM_MODE', defaultProviderMode),
      payments: providerMode('PAYMENTS_MODE', defaultProviderMode),
      storage: providerMode('STORAGE_MODE', defaultProviderMode),
      mock: {
        failureRate: float('MOCK_FAILURE_RATE', 0),
        latencyMs: int('MOCK_LATENCY_MS', 0),
        seed: str('MOCK_SEED', 'aiking-dev'),
      },
    },

    whatsapp: {
      apiVersion: str('WHATSAPP_API_VERSION', 'v21.0'),
      phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID', ''),
      accessToken: str('WHATSAPP_ACCESS_TOKEN', ''),
      businessAccountId: str('WHATSAPP_BUSINESS_ACCOUNT_ID', ''),
      appSecret: str('WHATSAPP_APP_SECRET', 'mock-meta-app-secret'),
      verifyToken: str('WHATSAPP_VERIFY_TOKEN', 'mock-meta-verify-token'),
    },

    email: {
      transport: emailTransportRaw,
      from: str('EMAIL_FROM', 'Aiking Solutions <no-reply@aiking.example>'),
      smtp: {
        host: str('SMTP_HOST', 'localhost'),
        port: int('SMTP_PORT', 1025),
        secure: bool('SMTP_SECURE', false),
        user: process.env.SMTP_USER || undefined,
        pass: process.env.SMTP_PASS || undefined,
      },
      sesRegion: str('AWS_SES_REGION', 'ap-south-1'),
      webhookSecret: str('EMAIL_WEBHOOK_SECRET', 'mock-email-webhook-secret'),
    },

    plivo: {
      authId: str('PLIVO_AUTH_ID', ''),
      authToken: str('PLIVO_AUTH_TOKEN', 'mock-plivo-auth-token'),
      fromNumber: str('PLIVO_FROM_NUMBER', '+911140000000'),
      // Plivo must be able to reach this to deliver call events, so it defaults to
      // the same public origin rather than to localhost independently.
      callbackBaseUrl: str('PLIVO_CALLBACK_BASE_URL', publicBaseUrl).replace(/\/$/, ''),
    },

    deepgram: {
      apiKey: str('DEEPGRAM_API_KEY', ''),
      model: str('DEEPGRAM_MODEL', 'nova-2'),
    },

    gemini: {
      apiKey: str('GEMINI_API_KEY', ''),
      model: str('GEMINI_MODEL', 'gemini-2.0-flash'),
      // Spec §5 — the provider layer exists so Gemini Live can be swapped in
      // without a pipeline rewrite. This flag is that switch.
      liveEnabled: bool('GEMINI_LIVE_ENABLED', false),
    },

    razorpay: {
      keyId: str('RAZORPAY_KEY_ID', 'rzp_test_mock'),
      keySecret: str('RAZORPAY_KEY_SECRET', 'mock-razorpay-key-secret'),
      webhookSecret: str('RAZORPAY_WEBHOOK_SECRET', 'mock-razorpay-webhook-secret'),
      currency: str('RAZORPAY_CURRENCY', 'INR'),
    },

    storage: {
      bucket: str('S3_BUCKET', 'aiking-local'),
      region: str('AWS_REGION', 'ap-south-1'),
      localDir: str('LOCAL_STORAGE_DIR', './storage'),
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
      endpoint: process.env.S3_ENDPOINT || undefined,
      // Required by MinIO and most S3-compatible stores; harmless against real S3.
      forcePathStyle: bool('S3_FORCE_PATH_STYLE', Boolean(process.env.S3_ENDPOINT)),
    },

    billing: {
      whatsappMessagePaise: bigintPaise('PRICE_WHATSAPP_MESSAGE_PAISE', 85n),
      emailMessagePaise: bigintPaise('PRICE_EMAIL_MESSAGE_PAISE', 12n),
      aiCallMinutePaise: bigintPaise('PRICE_AI_CALL_MINUTE_PAISE', 650n),
      // Spec §8.3 — free credits at onboarding, ₹500.00 by default.
      onboardingFreeCreditsPaise: bigintPaise('ONBOARDING_FREE_CREDITS_PAISE', 50_000n),
    },

    security: {
      // Spec §4.3 — RLS is a "candidate structural backstop", off by default.
      enableRls: bool('ENABLE_RLS', false),
    },

    logging: {
      level: str('LOG_LEVEL', 'info'),
      pretty: bool('LOG_PRETTY', !isProduction),
    },
  };
}

/**
 * Boot-time log line. Every credential is reduced to present/absent so a log
 * aggregator never receives a provider key (spec §12).
 */
export function redactedSummary(config: AppConfig): Record<string, unknown> {
  const present = (value: string) => (value ? 'set' : 'unset');
  return {
    nodeEnv: config.nodeEnv,
    appRole: config.appRole,
    port: config.api.port,
    queueDriver: config.queue.driver,
    providerMode: config.providers.default,
    providers: {
      whatsapp: config.providers.whatsapp,
      email: config.providers.email,
      telephony: config.providers.telephony,
      stt: config.providers.stt,
      llm: config.providers.llm,
      payments: config.providers.payments,
      storage: config.providers.storage,
    },
    credentials: {
      whatsappAccessToken: present(config.whatsapp.accessToken),
      plivoAuthId: present(config.plivo.authId),
      deepgramApiKey: present(config.deepgram.apiKey),
      geminiApiKey: present(config.gemini.apiKey),
      razorpayKeySecret: present(config.razorpay.keySecret),
      jwtSecret: present(config.auth.jwtSecret),
    },
    rlsEnabled: config.security.enableRls,
    // Host and database only — never the password.
    database: safeDatabaseLabel(config.database.url),
  };
}

function safeDatabaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

export const CONFIG = 'AIKING_CONFIG';

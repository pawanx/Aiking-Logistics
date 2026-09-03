import { Global, Module } from '@nestjs/common';

import { CONFIG, loadConfig, type AppConfig } from './configuration';

/**
 * Global config module. `loadConfig()` runs once and throws on a bad or missing
 * required variable, so the process fails at boot rather than at the first
 * request that needs the value.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [CONFIG],
})
export class AppConfigModule {}

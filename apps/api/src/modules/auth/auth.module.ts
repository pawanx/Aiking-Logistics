import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Authentication — spec §4.1.
 *
 * `JwtModule` is not imported here: `CommonModule` registers it globally so the
 * middleware that *verifies* tokens and the service that *signs* them cannot end up
 * using different secrets.
 *
 * `AuthService` is exported because tenant onboarding and staff invitation both need
 * `hashPassword` — one bcrypt cost setting, one place.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}

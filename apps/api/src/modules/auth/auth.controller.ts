import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, type AuthenticatedUser, type LoginRequest, type LoginResponse } from '@aiking/shared';
import type { Response } from 'express';

import type { RequestPrincipal } from '../../common/auth/jwt-payload';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { ValidationFailedException } from '../../common/errors/app-exception';
import { AuthService } from './auth.service';

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

/** Cookie name the middleware also accepts a token from, for the web app's SSR fetches. */
const TOKEN_COOKIE = 'aiking_token';

/**
 * Auth endpoints — spec §4.1.
 *
 * The token is returned in the body *and* set as an httpOnly cookie. The body is what
 * a script or the smoke test uses; the cookie is what lets the Next.js server
 * components call the API on the user's behalf without the token passing through
 * client-readable JavaScript.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public('credentials are the authentication')
  @ApiOperation({ summary: 'Exchange credentials for a JWT (spec §4.1)' })
  async login(@Body() body: LoginRequest, @Res({ passthrough: true }) response: Response): Promise<LoginResponse> {
    const result = await this.auth.login(body);

    response.cookie(TOKEN_COOKIE, result.accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      // Set only over HTTPS in production; a `secure` cookie would never be stored
      // over plain http://localhost during development.
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });

    return result;
  }

  /** Clears the cookie. The JWT itself stays valid until it expires — it is stateless. */
  @Post('logout')
  @Public('clearing a cookie needs no authorization')
  @ApiOperation({ summary: 'Clear the session cookie' })
  logout(@Res({ passthrough: true }) response: Response): { ok: true } {
    response.clearCookie(TOKEN_COOKIE, { path: '/' });
    return { ok: true };
  }

  /**
   * The caller's identity with permissions **re-resolved from the current tenant
   * policy**, not from the token. That is what makes a §4.4 policy change take effect
   * in the UI within one page load.
   */
  @Get('me')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER, Role.STAFF)
  @ApiOperation({ summary: 'Current user, with freshly resolved permissions' })
  async me(@CurrentUser() principal: RequestPrincipal): Promise<AuthenticatedUser> {
    return this.auth.describe(principal);
  }

  /** Tenants this account can open a session against, for a tenant switcher. */
  @Get('memberships')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER, Role.STAFF)
  @ApiOperation({ summary: 'Tenants this account belongs to' })
  async memberships(@CurrentUser() principal: RequestPrincipal) {
    return this.auth.memberships(principal.userId);
  }

  @Post('password')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER, Role.STAFF)
  @ApiOperation({ summary: 'Change your own password' })
  async changePassword(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: ChangePasswordBody,
  ): Promise<{ ok: true }> {
    if (!body.currentPassword || !body.newPassword) {
      throw new ValidationFailedException('currentPassword and newPassword are both required');
    }
    await this.auth.changePassword(principal.userId, body.currentPassword, body.newPassword);
    return { ok: true };
  }
}

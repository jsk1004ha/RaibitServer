import { Body, Controller, Get, HttpCode, HttpException, Post, Query, Req, Res } from '@nestjs/common';
import { PASSWORD_RESET_COOLDOWN_SECONDS, publicOAuthError } from '@raibitserver/core';
import { RequirePermission } from '../../auth/permissions.decorator';
import { AuthService } from './auth.service';
import type { IncomingMessage, ServerResponse } from 'node:http';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  signup(@Body() input: Record<string, any>, @Req() req: any) {
    return this.authService.signup(input, req);
  }

  @Post('login')
  login(@Body() input: Record<string, any>, @Req() req: any) {
    return this.authService.login(input, req);
  }

  @Post('email/verify')
  verifyEmail(@Body() input: Record<string, any>, @Req() req: any) {
    return this.authService.verifyEmail(input, req);
  }

  @Post('email/resend')
  resendEmailVerification(@Body() input: Record<string, any>, @Req() req: any) {
    return this.authService.resendEmailVerification(input, req);
  }

  @Post('password-reset/request')
  @HttpCode(202)
  requestPasswordReset(@Body() input: Record<string, unknown>, @Req() req: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    response.setHeader('Retry-After', String(PASSWORD_RESET_COOLDOWN_SECONDS));
    return this.authService.requestPasswordReset(input, req, response);
  }

  @Post('password-reset/complete')
  @HttpCode(200)
  completePasswordReset(@Body() input: Record<string, unknown>, @Req() req: IncomingMessage) {
    return this.authService.completePasswordReset(input, req);
  }

  @Get('github/login')
  githubLogin(@Query() input: Record<string, unknown>, @Req() req: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    return oauthResponse(response, () => this.authService.githubLogin(input || {}, req));
  }

  @Get('github/callback')
  githubCallback(@Query() input: Record<string, unknown>, @Req() req: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse) {
    return oauthResponse(response, () => this.authService.githubCallback(input || {}, req));
  }

  @RequirePermission('project:read')
  @Get('me')
  me(@Req() req: any) {
    return this.authService.currentUser(req.raibitSubject);
  }

  @RequirePermission('project:read')
  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: any) {
    return this.authService.logout(req.raibitSubject);
  }
}

async function oauthResponse<T>(response: ServerResponse, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    const safe = publicOAuthError(error);
    if (safe.statusCode === 429) response.setHeader('Retry-After', String(safe.retryAfterSeconds));
    throw new HttpException({ statusCode: safe.statusCode, message: safe.code, error: safe.code }, safe.statusCode);
  }
}

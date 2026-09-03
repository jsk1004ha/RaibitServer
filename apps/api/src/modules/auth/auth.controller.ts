import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { RequirePermission } from '../../auth/permissions.decorator';
import { AuthService } from './auth.service';
import type { IncomingMessage } from 'node:http';

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

  @Get('github/login')
  githubLogin(@Query() input: Record<string, unknown>, @Req() req: IncomingMessage) {
    return this.authService.githubLogin(input || {}, req);
  }

  @Get('github/callback')
  githubCallback(@Query() input: Record<string, unknown>, @Req() req: IncomingMessage) {
    return this.authService.githubCallback(input || {}, req);
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

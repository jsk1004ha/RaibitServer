import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { authorizeSubject, devHeaderAuthAllowed, safeAuthModeFromEnv, subjectFromRequest } from '@raibitserver/core';
import { RAIBITSERVER_PERMISSION } from './permissions.decorator';
import { RAIBITSERVERService } from '../raibitserver.service';

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly controlPlane: RAIBITSERVERService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<string>(RAIBITSERVER_PERMISSION, [context.getHandler(), context.getClass()]);
    if (!permission) return true;
    const req = context.switchToHttp().getRequest();
    // Scope checks need repository/project ownership context; controllers/services
    // enforce that after the action-level RBAC check succeeds.
    req.raibitSubject = subjectFromRequest(req, authConfig());
    await this.controlPlane.validateSessionSubject(req.raibitSubject);
    req.raibitSubject = authorizeSubject(req.raibitSubject, permission);
    return true;
  }
}

function authConfig() {
  const jwtSecret = process.env.RAIBITSERVER_AUTH_JWT_SECRET || '';
  const mode = safeAuthModeFromEnv(process.env);
  return {
    mode,
    allowDisabled: mode === 'disabled',
    jwtSecret,
    issuer: process.env.RAIBITSERVER_AUTH_ISSUER || 'raibitserver',
    audience: process.env.RAIBITSERVER_AUTH_AUDIENCE || 'raibitserver-api',
    allowDevHeaders: devHeaderAuthAllowed(process.env),
    defaultRole: process.env.RAIBITSERVER_ROLE || 'owner',
  };
}

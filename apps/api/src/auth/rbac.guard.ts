import { CanActivate, ExecutionContext, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
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
    req.raibitSubject = subjectFromRequest(req, authConfig());
    await this.controlPlane.validateSessionSubject(req.raibitSubject);
    try {
      await this.controlPlane.assertScopedRequestAccess(req.params ?? {}, req.query ?? {}, req.raibitSubject);
    } catch (error) {
      const route = this.reflector.get<string>(PATH_METADATA, context.getHandler());
      if (error instanceof HttpException && error.getStatus() === 404 &&
          (route === 'deployments/:deploymentId/retry' || route === 'services/:serviceId/redeploy')) {
        // Keep the retry contract identical for missing and out-of-scope sources.
        throw new NotFoundException({ statusCode: 404, message: 'DEPLOYMENT_SOURCE_NOT_FOUND', code: 'DEPLOYMENT_SOURCE_NOT_FOUND' });
      }
      throw error;
    }
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

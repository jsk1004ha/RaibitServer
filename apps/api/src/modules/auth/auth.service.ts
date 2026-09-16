import { Injectable } from '@nestjs/common';
import { RAIBITSERVERService } from '../../raibitserver.service';
import type { IncomingMessage, ServerResponse } from 'node:http';

@Injectable()
export class AuthService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  signup(input: Record<string, any>, req?: any) { return this.controlPlane.signup(input, { request: req }); }
  login(input: Record<string, any>, req?: any) { return this.controlPlane.login(input, { request: req }); }
  verifyEmail(input: Record<string, any>, req?: any) { return this.controlPlane.verifyEmail(input, { request: req }); }
  resendEmailVerification(input: Record<string, any>, req?: any) { return this.controlPlane.resendEmailVerification(input, { request: req }); }
  requestPasswordReset(input: Record<string, unknown>, req: IncomingMessage, response: ServerResponse) { return this.controlPlane.requestPasswordReset(input, { request: req, response }); }
  completePasswordReset(input: Record<string, unknown>, req: IncomingMessage) { return this.controlPlane.completePasswordReset(input, { request: req }); }
  githubLogin(input: Record<string, unknown>, req: IncomingMessage) { return this.controlPlane.githubLogin(input, req); }
  githubCallback(input: Record<string, unknown>, req: IncomingMessage) { return this.controlPlane.githubCallback(input, req); }
  currentUser(subject: Record<string, any>) { return this.controlPlane.currentUser(subject); }
  logout(subject: Record<string, any>) { return this.controlPlane.logout(subject); }
}

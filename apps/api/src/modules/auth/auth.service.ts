import { Injectable } from '@nestjs/common';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class AuthService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  signup(input: Record<string, any>, req?: any) { return this.controlPlane.signup(input, { request: req }); }
  login(input: Record<string, any>, req?: any) { return this.controlPlane.login(input, { request: req }); }
  verifyEmail(input: Record<string, any>, req?: any) { return this.controlPlane.verifyEmail(input, { request: req }); }
  resendEmailVerification(input: Record<string, any>, req?: any) { return this.controlPlane.resendEmailVerification(input, { request: req }); }
  githubLogin(input: Record<string, any>) { return this.controlPlane.githubLogin(input); }
  githubCallback(input: Record<string, any>) { return this.controlPlane.githubCallback(input); }
  currentUser(subject: Record<string, any>) { return this.controlPlane.currentUser(subject); }
  logout(subject: Record<string, any>) { return this.controlPlane.logout(subject); }
}

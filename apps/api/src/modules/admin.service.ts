import { Injectable } from '@nestjs/common';
import { RAIBITSERVERService } from '../raibitserver.service';

@Injectable()
export class AdminService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  approveUser(userId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.approveUser(userId, input, subject); }
  rejectUser(userId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.rejectUser(userId, input, subject); }
  setUserQuota(userId: string, input: Record<string, any>, subject: Record<string, any>) { return this.controlPlane.setUserQuota(userId, input, subject); }
  overview(subject: Record<string, any>, options: Record<string, any> = {}) { return this.controlPlane.adminOverview(subject, options); }
}

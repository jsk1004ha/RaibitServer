import { Injectable } from '@nestjs/common';
import type { CustomDomainCreate, CustomDomainMutation, CustomDomainRotate } from '@raibitserver/schemas';
import { RAIBITSERVERService } from '../../raibitserver.service';

@Injectable()
export class DomainsService {
  constructor(private readonly controlPlane: RAIBITSERVERService) {}

  list(projectId: string, subject: Record<string, unknown>) { return this.controlPlane.listDomains(projectId, subject); }
  create(projectId: string, input: CustomDomainCreate, subject: Record<string, unknown>) { return this.controlPlane.createDomain(projectId, input, subject); }
  status(domainId: string, subject: Record<string, unknown>) { return this.controlPlane.getDomain(domainId, subject); }
  rotate(domainId: string, input: CustomDomainRotate, subject: Record<string, unknown>) { return this.controlPlane.rotateDomain(domainId, input, subject); }
  verify(domainId: string, input: CustomDomainMutation, subject: Record<string, unknown>) { return this.controlPlane.verifyDomain(domainId, input, subject); }
  delete(domainId: string, input: CustomDomainMutation, subject: Record<string, unknown>) { return this.controlPlane.deleteDomain(domainId, input, subject); }
}

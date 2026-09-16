import { HttpException, Inject, Injectable } from '@nestjs/common';

type BackupPolicySubject = Readonly<{ id?: unknown; role?: unknown; organizationId?: unknown; organizationIds?: unknown }>;
type BackupPolicyRecordView = Readonly<{
  id: string;
  resourceId: string;
  enabled: boolean;
  timezone: 'Asia/Seoul';
  localMinute: number;
  version: number;
  nextRunAt: string | null;
}>;
type BackupPolicyContextView = Readonly<{ policy: BackupPolicyRecordView }>;
type BackupRunPageView = Readonly<{ runs: readonly Readonly<Record<string, unknown>>[]; nextCursor: string | null }>;

export abstract class BackupPolicyPersistence {
  abstract getBackupPolicyContext(input: Readonly<{ resourceId: string; subject: BackupPolicySubject }>): Promise<BackupPolicyContextView>;
  abstract updateBackupPolicy(input: Readonly<{ resourceId: string; subject: BackupPolicySubject; input: unknown }>): Promise<BackupPolicyRecordView>;
  abstract listBackupPolicyRuns(input: Readonly<{ resourceId: string; subject: BackupPolicySubject; query: Readonly<Record<string, unknown>> }>): Promise<BackupRunPageView>;
}

export class DeferredBackupPolicyPersistence extends BackupPolicyPersistence {
  private delegatePromise: Promise<BackupPolicyPersistence> | null = null;
  private readonly load: () => Promise<BackupPolicyPersistence>;

  constructor(load: () => Promise<BackupPolicyPersistence>) {
    super();
    this.load = load;
  }

  getBackupPolicyContext(input: Readonly<{ resourceId: string; subject: BackupPolicySubject }>): Promise<BackupPolicyContextView> {
    return this.delegate().then(persistence => persistence.getBackupPolicyContext(input));
  }

  updateBackupPolicy(input: Readonly<{ resourceId: string; subject: BackupPolicySubject; input: unknown }>): Promise<BackupPolicyRecordView> {
    return this.delegate().then(persistence => persistence.updateBackupPolicy(input));
  }

  listBackupPolicyRuns(input: Readonly<{ resourceId: string; subject: BackupPolicySubject; query: Readonly<Record<string, unknown>> }>): Promise<BackupRunPageView> {
    return this.delegate().then(persistence => persistence.listBackupPolicyRuns(input));
  }

  private delegate(): Promise<BackupPolicyPersistence> {
    this.delegatePromise ??= this.load();
    return this.delegatePromise;
  }
}

@Injectable()
export class BackupPolicyService {
  constructor(@Inject(BackupPolicyPersistence) private readonly persistence: BackupPolicyPersistence) {}

  async getPolicy(resourceId: string, subject: BackupPolicySubject): Promise<BackupPolicyRecordView> {
    return this.boundary(async () => (await this.persistence.getBackupPolicyContext({ resourceId, subject })).policy);
  }

  async updatePolicy(resourceId: string, input: unknown, subject: BackupPolicySubject): Promise<BackupPolicyRecordView> {
    return this.boundary(() => this.persistence.updateBackupPolicy({ resourceId, subject, input }));
  }

  async listRuns(resourceId: string, query: Readonly<Record<string, unknown>>, subject: BackupPolicySubject): Promise<BackupRunPageView> {
    return this.boundary(() => this.persistence.listBackupPolicyRuns({ resourceId, subject, query }));
  }

  private async boundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error) {
        const statusCode = Reflect.get(error, 'statusCode');
        const code = Reflect.get(error, 'code');
        if (typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 && typeof code === 'string') {
          throw new HttpException({ statusCode, code }, statusCode);
        }
      }
      throw error;
    }
  }
}

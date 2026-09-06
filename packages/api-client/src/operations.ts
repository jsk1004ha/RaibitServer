import { apiOperations, ErrorBody, z } from '@raibitserver/schemas';
import { RuntimeLogStreamCursorSchema } from './runtime-log-stream.ts';

export class ApiOperationError extends Error {
  readonly name: string = 'ApiOperationError';
  readonly status: number;
  readonly body: z.output<typeof ErrorBody>;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly permission: boolean;
  constructor(status: number, body: z.output<typeof ErrorBody>) {
    super(`RAIBITSERVER API ${status}: ${body.message}`);
    this.status = status;
    this.body = body;
    this.permission = status === 401 || status === 403 || ('permission' in body && body.permission === true);
    this.retryable = !this.permission && (('retryable' in body && body.retryable === true) || status === 408 || status === 429 || status >= 500);
    this.terminal = !this.retryable;
  }
}

export class ApiPermissionError extends ApiOperationError { readonly name = 'ApiPermissionError'; }
export class ApiRetryableError extends ApiOperationError { readonly name = 'ApiRetryableError'; }
export class ApiTerminalError extends ApiOperationError { readonly name = 'ApiTerminalError'; }
export function apiOperationError(status: number, value: unknown): ApiOperationError {
  const body = ErrorBody.parse(value);
  if (status === 401 || status === 403 || ('permission' in body && body.permission === true)) return new ApiPermissionError(status, body);
  if (('retryable' in body && body.retryable === true) || status === 408 || status === 429 || status >= 500) return new ApiRetryableError(status, body);
  return new ApiTerminalError(status, body);
}
export type OperationTransport = { readonly baseUrl: string; readonly token?: string };
export type RequestOptions<T = unknown> = {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly lastEventId?: string;
  readonly onStreamEvent?: (value: T, eventId?: string) => void;
};
type WireInput = { readonly path: Readonly<Record<string, string>>; readonly query?: Readonly<Record<string, string | number | undefined>>; readonly body?: object };
type Contract<I extends z.ZodType<WireInput>, O extends z.ZodType> = { readonly method: string; readonly path: string; readonly input: I; readonly response: O; readonly stream?: string };
const DeploymentActivityStreamCursorSchema = z.string().min(1).max(4_096).regex(/^[^\u0000-\u001f\u007f]+$/);

export function createOperationsClient(transport: OperationTransport) {
  function bind<I extends z.ZodType<WireInput>, O extends z.ZodType>(contract: Contract<I, O>) {
    return async (input: z.input<I>, options: RequestOptions<z.output<O>> = {}): Promise<z.output<O>> => {
      const parsed = contract.input.parse(input);
      const path = contract.path.replace(/\{([^}]+)\}/g, (_match, key: string) => encodeURIComponent(parsed.path[key] ?? ''));
      const url = new URL(`${transport.baseUrl.replace(/\/$/, '')}${path}`);
      for (const [key, value] of Object.entries(parsed.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
      const headers: Record<string, string> = Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'last-event-id'),
      );
      if (transport.token) headers.authorization = `Bearer ${transport.token}`;
      if (contract.stream && options.lastEventId !== undefined) {
        const cursorSchema = contract.path === '/deployments/{deploymentId}/stream' ? DeploymentActivityStreamCursorSchema : RuntimeLogStreamCursorSchema;
        headers['last-event-id'] = cursorSchema.parse(options.lastEventId);
      }
      if (contract.stream) headers.accept = 'text/event-stream';
      const sendsBody = contract.method !== 'get' && Object.keys(parsed.body ?? {}).length > 0;
      if (sendsBody) headers['content-type'] = 'application/json';
      // Native fetch matches the existing client transport; bounded cancellation
      // and typed HTTP errors are enforced here, including open SSE connections.
      const signal = options.signal ?? (contract.stream ? undefined : AbortSignal.timeout(30_000));
      const response = await fetch(url, { method: contract.method.toUpperCase(), headers, body: sendsBody ? JSON.stringify(parsed.body) : undefined, ...(signal ? { signal } : {}) });
      if (!response.ok) {
        throw apiOperationError(response.status, await response.json());
      }
      if (!contract.stream) return contract.response.parse(await response.json());
      const reader = response.body?.getReader();
      if (!reader) throw new TypeError('SSE response body is missing');
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new TypeError('SSE ended before a snapshot');
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split(/(?:\r?\n){2}/);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const lines = frame.split(/\r?\n/);
            if (!lines.some((line) => line === `event: ${contract.stream}`)) continue;
            const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
            const value = contract.response.parse(JSON.parse(data));
            if (!options.onStreamEvent) return value;
            const rawEventId = lines.find((line) => line.startsWith('id: '))?.slice(4);
            const eventId = rawEventId === undefined ? undefined : (contract.path === '/deployments/{deploymentId}/stream' ? DeploymentActivityStreamCursorSchema : RuntimeLogStreamCursorSchema).parse(rawEventId);
            options.onStreamEvent(value, eventId);
          }
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
    };
  }
  return {
    'deployments-retry': bind(apiOperations['deployments-retry']),
    'services-redeploy': bind(apiOperations['services-redeploy']),
    'project-deployment-history': bind(apiOperations['project-deployment-history']),
    'health': bind(apiOperations.health),
    'auth-signup': bind(apiOperations['auth-signup']),
    'auth-login': bind(apiOperations['auth-login']),
    'auth-email-verify': bind(apiOperations['auth-email-verify']),
    'auth-email-resend': bind(apiOperations['auth-email-resend']),
    'auth-password-reset-request': bind(apiOperations['auth-password-reset-request']),
    'auth-password-reset-complete': bind(apiOperations['auth-password-reset-complete']),
    'auth-github-login': bind(apiOperations['auth-github-login']),
    'auth-github-callback': bind(apiOperations['auth-github-callback']),
    'auth-me': bind(apiOperations['auth-me']),
    'auth-logout': bind(apiOperations['auth-logout']),
    'public-sites': bind(apiOperations['public-sites']),
    'organizations-invites': bind(apiOperations['organizations-invites']),
    'organizations-invites-post': bind(apiOperations['organizations-invites-post']),
    'organization-invites-accept-post': bind(apiOperations['organization-invites-accept-post']),
    'organizations-members': bind(apiOperations['organizations-members']),
    'organizations-members-patch': bind(apiOperations['organizations-members-patch']),
    'organizations-members-delete': bind(apiOperations['organizations-members-delete']),
    'organizations-leave-post': bind(apiOperations['organizations-leave-post']),
    'organizations-invites-delete': bind(apiOperations['organizations-invites-delete']),
    'projects-list': bind(apiOperations['projects-list']),
    'projects-create': bind(apiOperations['projects-create']),
    'projects-get': bind(apiOperations['projects-get']),
    'projects-update': bind(apiOperations['projects-update']),
    'projects-delete': bind(apiOperations['projects-delete']),
    'project-settings-get': bind(apiOperations['project-settings-get']),
    'project-settings-update': bind(apiOperations['project-settings-update']),
    'project-settings-delete': bind(apiOperations['project-settings-delete']),
    'projects-overview': bind(apiOperations['projects-overview']),
    'services-list': bind(apiOperations['services-list']),
    'services-create': bind(apiOperations['services-create']),
    'services-get': bind(apiOperations['services-get']),
    'services-update': bind(apiOperations['services-update']),
    'services-settings-get': bind(apiOperations['services-settings-get']),
    'services-settings-preview': bind(apiOperations['services-settings-preview']),
    'services-settings-update': bind(apiOperations['services-settings-update']),
    'services-replacements-create': bind(apiOperations['services-replacements-create']),
    'services-delete': bind(apiOperations['services-delete']),
    'domains-list': bind(apiOperations['domains-list']),
    'domains-create': bind(apiOperations['domains-create']),
    'domains-status': bind(apiOperations['domains-status']),
    'domains-rotate': bind(apiOperations['domains-rotate']),
    'domains-verify': bind(apiOperations['domains-verify']),
    'domains-delete': bind(apiOperations['domains-delete']),
    'project-deployments-list': bind(apiOperations['project-deployments-list']),
    'project-deployments-create': bind(apiOperations['project-deployments-create']),
    'deployments-list': bind(apiOperations['deployments-list']),
    'deployments-create': bind(apiOperations['deployments-create']),
    'deployments-get': bind(apiOperations['deployments-get']),
    'deployments-status': bind(apiOperations['deployments-status']),
    'deployments-status-post': bind(apiOperations['deployments-status-post']),
    'deployments-cancel': bind(apiOperations['deployments-cancel']),
    'deployments-rollback': bind(apiOperations['deployments-rollback']),
    'deployments-preview-cleanup': bind(apiOperations['deployments-preview-cleanup']),
    'deployments-logs': bind(apiOperations['deployments-logs']),
    'deployments-events': bind(apiOperations['deployments-events']),
    'deployments-stream': bind(apiOperations['deployments-stream']),
    'services-logs': bind(apiOperations['services-logs']),
    'services-logs-stream': bind(apiOperations['services-logs-stream']),
    'agent-plan': bind(apiOperations['agent-plan']),
    'agent-apply': bind(apiOperations['agent-apply']),
    'resources-list': bind(apiOperations['resources-list']),
    'resources-create': bind(apiOperations['resources-create']),
    'resources-get': bind(apiOperations['resources-get']),
    'resources-update': bind(apiOperations['resources-update']),
    'resources-delete': bind(apiOperations['resources-delete']),
    'resources-attach': bind(apiOperations['resources-attach']),
    'resources-provision': bind(apiOperations['resources-provision']),
    'resource-backups-create': bind(apiOperations['resource-backups-create']),
    'resource-backups-list': bind(apiOperations['resource-backups-list']),
    'resource-backups-delete': bind(apiOperations['resource-backups-delete']),
    'backup-restores-create': bind(apiOperations['backup-restores-create']),
    'restores-get': bind(apiOperations['restores-get']),
    'console-schema': bind(apiOperations['console-schema']),
    'console-tables': bind(apiOperations['console-tables']),
    'console-table': bind(apiOperations['console-table']),
    'console-collections': bind(apiOperations['console-collections']),
    'console-keys': bind(apiOperations['console-keys']),
    'console-query': bind(apiOperations['console-query']),
    'console-command': bind(apiOperations['console-command']),
    'console-browse': bind(apiOperations['console-browse']),
    'environment-list': bind(apiOperations['environment-list']),
    'environment-upsert': bind(apiOperations['environment-upsert']),
    'environment-upload': bind(apiOperations['environment-upload']),
    'github-install': bind(apiOperations['github-install']),
    'github-authorize': bind(apiOperations['github-authorize']),
    'github-callback': bind(apiOperations['github-callback']),
    'github-installations': bind(apiOperations['github-installations']),
    'github-integrations-create': bind(apiOperations['github-integrations-create']),
    'github-integrations-list': bind(apiOperations['github-integrations-list']),
    'github-integrations-disconnect': bind(apiOperations['github-integrations-disconnect']),
    'github-attach': bind(apiOperations['github-attach']),
    'github-repositories': bind(apiOperations['github-repositories']),
    'github-webhooks': bind(apiOperations['github-webhooks']),
    'github-import': bind(apiOperations['github-import']),
    'github-sync': bind(apiOperations['github-sync']),
    'admin-approve': bind(apiOperations['admin-approve']),
    'admin-reject': bind(apiOperations['admin-reject']),
    'admin-ban': bind(apiOperations['admin-ban']),
    'admin-unban': bind(apiOperations['admin-unban']),
    'admin-quota': bind(apiOperations['admin-quota']),
    'admin-quota-post': bind(apiOperations['admin-quota-post']),
    'snapshot': bind(apiOperations.snapshot),
    'usage-me': bind(apiOperations['usage-me']),
  };
}

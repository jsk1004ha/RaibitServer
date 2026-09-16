import { z } from '@raibitserver/schemas';

const serviceId = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
export const RuntimeLogStreamCursorSchema = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f]+$/);

export const RuntimeLogStreamRequestSchema = z.object({
  serviceId,
  lastEventId: RuntimeLogStreamCursorSchema.optional(),
}).strict();

export type RuntimeLogStreamRequest = z.input<typeof RuntimeLogStreamRequestSchema>;
export type RuntimeLogStreamResponse = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
};

export const RUNTIME_LOG_STREAM_EVENT = 'service.logs.snapshot';

export function runtimeLogStreamPath(request: RuntimeLogStreamRequest): string {
  const parsed = RuntimeLogStreamRequestSchema.parse(request);
  return `/services/${encodeURIComponent(parsed.serviceId)}/logs/stream`;
}

export function runtimeLogStreamUrl(baseUrl: string, request: RuntimeLogStreamRequest): string {
  return `${baseUrl.replace(/\/$/, '')}${runtimeLogStreamPath(request)}`;
}

export function createRuntimeLogStreamRequest(
  transport: { readonly baseUrl: string; readonly token?: string },
  request: RuntimeLogStreamRequest & {
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
  },
): RuntimeLogStreamResponse {
  const parsed = RuntimeLogStreamRequestSchema.parse(request);
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries(request.headers ?? {}).filter(([key]) => !['accept', 'last-event-id'].includes(key.toLowerCase())),
  );
  headers.accept = 'text/event-stream';
  if (transport.token) headers.authorization = `Bearer ${transport.token}`;
  if (parsed.lastEventId) headers['last-event-id'] = parsed.lastEventId;
  return {
    url: runtimeLogStreamUrl(transport.baseUrl, parsed),
    headers,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

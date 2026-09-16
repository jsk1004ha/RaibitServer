'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { sameOriginStreamHref } from '@/components/operation-submit';

type StreamRow = Readonly<{
  id?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  level?: unknown;
  type?: unknown;
  line?: unknown;
  message?: unknown;
}>;

type StreamSnapshot = Readonly<{
  deployment?: Readonly<{ status?: unknown }> | null;
  events: readonly StreamRow[];
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshot(value: unknown): StreamSnapshot | null {
  if (!isRecord(value)) return null;
  const events = Array.isArray(value.events) ? value.events.filter(isRecord) : [];
  const deployment = isRecord(value.deployment) ? value.deployment : null;
  return { deployment, events };
}

export function DeploymentActivityStream({ initialStatus, streamHref }: Readonly<{ initialStatus?: string; streamHref: string }>) {
  const href = sameOriginStreamHref(streamHref);
  const [status, setStatus] = useState(initialStatus || '');
  const [events, setEvents] = useState<readonly StreamRow[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'error'>(href ? 'connecting' : 'error');

  useEffect(() => {
    if (!href) return;
    const source = new EventSource(href);
    const onSnapshot = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return;
      try {
        const next = snapshot(JSON.parse(event.data));
        if (!next) {
          setConnection('error');
          return;
        }
        setStatus(typeof next.deployment?.status === 'string' ? next.deployment.status : '');
        setEvents(next.events.slice(-3));
        setConnection('live');
      } catch {
        setConnection('error');
      }
    };
    source.addEventListener('deployment.snapshot', onSnapshot);
    source.onerror = () => setConnection('error');
    return () => {
      source.removeEventListener('deployment.snapshot', onSnapshot);
      source.close();
    };
  }, [href]);

  return <section aria-label="배포 작업 스트림" className="flex min-w-0 flex-col gap-raibit-sm"><div className="flex flex-wrap items-center gap-raibit-sm"><Badge aria-live="polite" variant={connection === 'error' ? 'destructive' : 'secondary'}>{connection === 'live' ? '실시간 작업 스트림' : connection === 'connecting' ? '작업 스트림 연결 중' : '작업 스트림을 연결하지 못했습니다.'}</Badge>{status ? <Badge data-status={status} variant="outline">서버 확인 상태: {status}</Badge> : null}{href ? <a className="text-sm underline underline-offset-4" href={href}>작업 스트림 열기</a> : null}</div>{events.length > 0 ? <ol className="flex min-w-0 flex-col divide-y divide-border border-t border-border text-sm">{events.map((event, index) => <li className="grid min-w-0 gap-raibit-xs py-raibit-sm sm:grid-cols-[10rem_1fr]" key={String(event.id ?? index)}><time className="font-mono text-xs text-muted-foreground">{String(event.createdAt ?? event.timestamp ?? '이벤트')}</time><span className="min-w-0 break-words [overflow-wrap:anywhere]">{String(event.message ?? event.line ?? event.type ?? '')}</span></li>)}</ol> : null}</section>;
}

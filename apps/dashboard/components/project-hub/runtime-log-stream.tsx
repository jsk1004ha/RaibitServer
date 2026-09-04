'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { RuntimeLog, ServiceRecord } from './types';

const MAX_RUNTIME_LOG_ROWS = 200;
const MAX_SSE_FAILURES = 3;
const MAX_FALLBACK_POLLS = 12;
const FALLBACK_POLL_INTERVAL_MS = 5_000;

const streamLabels = {
  connecting: '연결 중',
  live: '실시간',
  reconnecting: '다시 연결 중',
  stopped: '중지됨',
  fallback: '폴링으로 확인 중',
  error: '오류',
} as const;

type StreamStatus = keyof typeof streamLabels;

type ParsedSnapshot = Readonly<{ logs: readonly RuntimeLog[] }>;

function runtimeLogKey(row: RuntimeLog): string {
  if (typeof row.id === 'string' && row.id.length > 0) return `id:${row.id}`;
  return `row:${row.createdAt ?? row.timestamp ?? ''}:${row.level ?? row.type ?? ''}:${row.line ?? row.message ?? ''}`;
}

function timestampValue(row: RuntimeLog): number | null {
  const value = row.createdAt ?? row.timestamp;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mergeRuntimeLogs(existing: readonly RuntimeLog[], incoming: readonly RuntimeLog[]): readonly RuntimeLog[] {
  const ordered = new Map<string, Readonly<{ row: RuntimeLog; index: number }>>();
  for (const row of [...existing, ...incoming]) {
    const key = runtimeLogKey(row);
    const previous = ordered.get(key);
    ordered.set(key, { row, index: previous?.index ?? ordered.size });
  }
  return [...ordered.values()]
    .sort((left, right) => {
      const leftTime = timestampValue(left.row);
      const rightTime = timestampValue(right.row);
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
      return left.index - right.index;
    })
    .slice(-MAX_RUNTIME_LOG_ROWS)
    .map((entry) => entry.row);
}

function isRuntimeLog(value: unknown): value is RuntimeLog {
  if (!isRecord(value)) return false;
  const row = value;
  return ['id', 'createdAt', 'timestamp', 'level', 'type', 'line', 'message'].every((field) => row[field] === undefined || typeof row[field] === 'string');
}

function parseSnapshot(data: string): ParsedSnapshot | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!isRecord(value)) return null;
    const logs = value.logs;
    return Array.isArray(logs) && logs.every(isRuntimeLog) ? { logs } : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function RuntimeLogRows({ rows }: Readonly<{ rows: readonly RuntimeLog[] }>) {
  if (rows.length === 0) {
    return <Empty className="min-h-48 border border-dashed border-border"><EmptyHeader><EmptyTitle>표시할 런타임 로그가 없습니다.</EmptyTitle><EmptyDescription>서비스가 로그를 기록하면 이곳에 표시됩니다.</EmptyDescription></EmptyHeader></Empty>;
  }
  return (
    <div className="max-h-[32rem] overflow-auto rounded-sm bg-inverse p-raibit-lg font-mono text-sm text-inverse-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" role="log" aria-label="런타임 로그" data-runtime-log-viewport tabIndex={0}>
      {rows.map((row) => <div className="grid min-w-0 gap-raibit-xs border-b border-white/10 py-raibit-sm last:border-0 lg:grid-cols-[minmax(13rem,14rem)_minmax(5rem,6rem)_minmax(0,1fr)]" key={runtimeLogKey(row)}>
        <span className="min-w-0 break-words text-white/60 [overflow-wrap:anywhere]">{row.createdAt ?? row.timestamp ?? '이벤트'}</span>
        <span className="min-w-0 break-words text-white/70 [overflow-wrap:anywhere]">{row.level ?? row.type ?? '정보'}</span>
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{row.line ?? row.message ?? ''}</span>
      </div>)}
    </div>
  );
}

export function LogServiceSelector({ base, selectedServiceId, services }: Readonly<{ base: string; selectedServiceId: string; services: readonly ServiceRecord[] }>) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-raibit-xs text-caption text-muted-foreground md:max-w-sm">
      로그 서비스
      <Select aria-label="로그 서비스" onChange={(event) => {
        const serviceId = event.currentTarget.value;
        if (!serviceId) return;
        const target = new URL(window.location.href);
        target.pathname = base;
        target.searchParams.set('view', 'logs');
        target.searchParams.set('serviceId', serviceId);
        window.location.assign(target.toString());
      }} value={selectedServiceId}>
        {services.map((service) => <option key={service.id} value={service.id}>{service.name || service.slug || service.id}</option>)}
      </Select>
    </label>
  );
}

export function RuntimeLogStream({ initialRows, serviceId }: Readonly<{ initialRows: readonly RuntimeLog[]; serviceId: string }>) {
  const initial = useMemo(() => mergeRuntimeLogs([], initialRows), [initialRows]);
  const [rows, setRows] = useState<readonly RuntimeLog[]>(initial);
  const [following, setFollowing] = useState(true);
  const [fallbackPolling, setFallbackPolling] = useState(false);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [level, setLevel] = useState('all');
  const [search, setSearch] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const failures = useRef(0);
  const pendingRows = useRef<readonly RuntimeLog[]>([]);
  const lastEventId = useRef('');
  const followingRef = useRef(true);

  useEffect(() => {
    setRows(initial);
    setFollowing(true);
    followingRef.current = true;
    setFallbackPolling(false);
    failures.current = 0;
    pendingRows.current = [];
    lastEventId.current = '';
  }, [initial, serviceId]);

  useEffect(() => {
    if (fallbackPolling) {
      return;
    }
    setStatus(followingRef.current ? 'connecting' : 'stopped');
    const source = new EventSource(`/api/control/services/${encodeURIComponent(serviceId)}/logs/stream`);
    const onSnapshot = (event: Event) => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return;
      if (event.lastEventId) lastEventId.current = event.lastEventId;
      const snapshot = parseSnapshot(event.data);
      if (!snapshot) {
        source.close();
        setStatus('error');
        return;
      }
      if (!followingRef.current) {
        pendingRows.current = mergeRuntimeLogs(pendingRows.current, snapshot.logs);
        return;
      }
      setRows((current) => mergeRuntimeLogs(current, snapshot.logs));
    };
    source.onopen = () => {
      failures.current = 0;
      setStatus(followingRef.current ? 'live' : 'stopped');
    };
    source.onerror = () => {
      failures.current += 1;
      if (failures.current >= MAX_SSE_FAILURES) {
        source.close();
        setFallbackPolling(true);
        return;
      }
      setStatus(source.readyState === EventSource.CLOSED ? 'stopped' : 'reconnecting');
    };
    source.addEventListener('service.logs.snapshot', onSnapshot);
    return () => {
      source.removeEventListener('service.logs.snapshot', onSnapshot);
      source.close();
    };
  }, [fallbackPolling, serviceId]);

  useEffect(() => {
    if (!fallbackPolling) return;
    let polls = 0;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      polls += 1;
      if (polls > MAX_FALLBACK_POLLS) {
        setStatus('stopped');
        return;
      }
      try {
        const response = await fetch(`/api/control/services/${encodeURIComponent(serviceId)}/logs?limit=${MAX_RUNTIME_LOG_ROWS}`, { cache: 'no-store' });
        const payload: unknown = await response.json();
        const snapshot = isRecord(payload) && Array.isArray(payload.logs) && payload.logs.every(isRuntimeLog) ? { logs: payload.logs } : null;
        if (cancelled || !response.ok || !snapshot) {
          if (!cancelled) setStatus('error');
          return;
        }
        if (following) setRows((current) => mergeRuntimeLogs(current, snapshot.logs));
        else pendingRows.current = mergeRuntimeLogs(pendingRows.current, snapshot.logs);
        setStatus(following ? 'fallback' : 'stopped');
      } catch {
        if (!cancelled) setStatus('error');
      }
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, FALLBACK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fallbackPolling, following, serviceId]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    const rowLevel = (row.level ?? row.type ?? 'info').toLowerCase();
    const line = row.line ?? row.message ?? '';
    return (level === 'all' || rowLevel === level) && line.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  }), [level, rows, search]);

  const toggleFollowing = () => {
    if (followingRef.current) {
      followingRef.current = false;
      setFollowing(false);
      setStatus('stopped');
      return;
    }
    setRows((current) => mergeRuntimeLogs(current, pendingRows.current));
    pendingRows.current = [];
    followingRef.current = true;
    setFollowing(true);
    setStatus(fallbackPolling ? 'fallback' : 'live');
  };

  const reconnectSse = () => {
    failures.current = 0;
    setFallbackPolling(false);
  };

  const copyVisibleRows = () => {
    const text = filteredRows.map((row) => `${row.createdAt ?? row.timestamp ?? '이벤트'} ${row.level ?? row.type ?? '정보'} ${row.line ?? row.message ?? ''}`).join('\n');
    if (text.length === 0) {
      setCopyStatus('복사할 로그가 없습니다.');
      return;
    }
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(text).then(() => setCopyStatus('표시한 로그를 복사했습니다.'), () => setCopyStatus(legacyCopy(text) ? '표시한 로그를 복사했습니다.' : '로그를 복사하지 못했습니다.'));
      return;
    }
    setCopyStatus(legacyCopy(text) ? '표시한 로그를 복사했습니다.' : '로그를 복사하지 못했습니다.');
  };

  const statusText = status === 'error' ? '로그 스트림을 확인하지 못했습니다.' : streamLabels[status];
  return (
    <div className="flex min-w-0 flex-col gap-raibit-md">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-raibit-sm">
        <Badge aria-live="polite" data-runtime-log-status={status} data-runtime-log-cursor={lastEventId.current || undefined} variant={status === 'error' ? 'destructive' : status === 'live' ? 'outline' : 'secondary'}>{statusText}</Badge>
        <div className="flex flex-wrap gap-raibit-sm"><Button onClick={toggleFollowing} size="sm" type="button" variant="outline">{following ? '실시간 따라가기 중지' : '실시간 따라가기 재개'}</Button>{fallbackPolling ? <Button onClick={reconnectSse} size="sm" type="button" variant="outline">SSE 다시 연결</Button> : null}</div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-raibit-sm">
        <label className="flex min-w-0 flex-col gap-raibit-xs text-caption text-muted-foreground">수준<Select aria-label="로그 수준" onChange={(event) => setLevel(event.currentTarget.value)} value={level}><option value="all">전체</option><option value="info">정보</option><option value="warn">경고</option><option value="error">오류</option></Select></label>
        <label className="flex min-w-0 flex-col gap-raibit-xs text-caption text-muted-foreground">검색<Input aria-label="로그 검색" onChange={(event) => setSearch(event.currentTarget.value)} value={search} /></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-raibit-sm"><p aria-live="polite" className="text-caption text-muted-foreground">{copyStatus}</p><Button onClick={copyVisibleRows} size="sm" type="button" variant="outline">표시한 로그 복사</Button></div>
      <RuntimeLogRows rows={filteredRows} />
    </div>
  );
}

function legacyCopy(text: string): boolean {
  const control = document.createElement('textarea');
  control.value = text;
  control.setAttribute('readonly', '');
  control.style.position = 'fixed';
  control.style.opacity = '0';
  document.body.append(control);
  control.select();
  const copied = document.execCommand('copy');
  control.remove();
  return copied;
}

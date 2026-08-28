'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemStatusSnapshot, SystemStatusTone } from '../lib/system-status';

const overallCopy: Record<SystemStatusTone, { title: string; detail: string }> = {
  operational: { title: '모든 시스템 정상', detail: 'RAIBIT SERVER가 정상 작동 중입니다.' },
  degraded: { title: '일부 확인 필요', detail: '일부 기능이 지연되고 있습니다.' },
  outage: { title: '시스템 장애', detail: '핵심 기능을 확인하고 있습니다.' },
};

const statusLabels: Record<SystemStatusTone, string> = {
  operational: '정상',
  degraded: '지연',
  outage: '장애',
};

export function SystemStatusPanel({ initialStatus }: { initialStatus: SystemStatusSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialStatus);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const copy = overallCopy[snapshot.status];

  const refresh = useCallback(async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    try {
      const response = await fetch('/api/status', {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok || !isSystemStatusSnapshot(payload)) throw new Error('invalid_status_response');
      setSnapshot(payload);
      setStale(false);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setStale(true);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void refresh(), snapshot.refreshIntervalSeconds * 1000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      requestRef.current?.abort();
    };
  }, [refresh, snapshot.refreshIntervalSeconds]);

  return (
    <section className="system-status" aria-labelledby="system-status-title" aria-busy={refreshing}>
      <header className="system-status-summary">
        <div className="system-status-summary-copy">
          <span className={`system-status-signal status-${snapshot.status}`} aria-hidden="true"><i /></span>
          <div>
            <h2 id="system-status-title">{copy.title}</h2>
            <p>{copy.detail}</p>
          </div>
        </div>
        <button
          className="btn status-refresh-button"
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label={refreshing ? '상태 확인 중' : '상태 새로고침'}
        >
          <RefreshIcon refreshing={refreshing} />
        </button>
      </header>

      <div className="system-status-list" role="list" aria-live="polite">
        {snapshot.components.map((component) => (
          <div className="system-status-row" role="listitem" key={component.id}>
            <div>
              <strong>{component.name}</strong>
              <small>{component.detail}{component.latencyMs === null ? '' : ` · ${component.latencyMs}ms`}</small>
            </div>
            <span className={`system-status-badge status-${component.status}`}>
              <i aria-hidden="true" />{statusLabels[component.status]}
            </span>
          </div>
        ))}
      </div>

      <footer className={`system-status-meta${stale ? ' is-stale' : ''}`}>
        <span className="system-status-refresh"><i aria-hidden="true" />{stale ? '자동 갱신 지연' : `${snapshot.refreshIntervalSeconds}초 자동 갱신`}</span>
        <span className="system-status-version">
          <span>배포 버전</span>
          {snapshot.deployment.commitUrl && snapshot.deployment.shortCommitSha
            ? <a href={snapshot.deployment.commitUrl} aria-label={`GitHub 커밋 ${snapshot.deployment.commitSha}`}>{snapshot.deployment.shortCommitSha}</a>
            : <strong>확인 불가</strong>}
        </span>
        <time dateTime={snapshot.checkedAt}>최근 확인 {formatCheckedAt(snapshot.checkedAt)}</time>
      </footer>
    </section>
  );
}

function RefreshIcon({ refreshing }: { refreshing: boolean }) {
  return (
    <svg
      className={`status-refresh-icon${refreshing ? ' is-spinning' : ''}`}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function isSystemStatusSnapshot(value: unknown): value is SystemStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SystemStatusSnapshot>;
  if (!['operational', 'degraded', 'outage'].includes(String(candidate.status))) return false;
  if (typeof candidate.checkedAt !== 'string' || !Number.isFinite(candidate.refreshIntervalSeconds) || !Array.isArray(candidate.components)) return false;
  if (!isDeploymentVersion(candidate.deployment)) return false;
  return candidate.components.every((component) => (
    component
    && typeof component.id === 'string'
    && typeof component.name === 'string'
    && ['operational', 'degraded', 'outage'].includes(String(component.status))
  ));
}

function isDeploymentVersion(value: unknown): value is SystemStatusSnapshot['deployment'] {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SystemStatusSnapshot['deployment']>;
  const nullableStrings = [candidate.repository, candidate.commitSha, candidate.shortCommitSha, candidate.commitUrl];
  if (!nullableStrings.every((field) => field === null || typeof field === 'string')) return false;
  if (candidate.repository !== null && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(candidate.repository || '')) return false;
  if (candidate.commitSha !== null && !/^[0-9a-f]{40}$/.test(candidate.commitSha || '')) return false;
  if (candidate.shortCommitSha !== (candidate.commitSha?.slice(0, 12) || null)) return false;
  const expectedUrl = candidate.repository && candidate.commitSha
    ? `https://github.com/${candidate.repository}/commit/${candidate.commitSha}`
    : null;
  return candidate.commitUrl === expectedUrl;
}

function formatCheckedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '확인 중';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

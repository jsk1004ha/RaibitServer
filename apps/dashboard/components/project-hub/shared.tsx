import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import type { DashboardLoadIssue } from '@/lib/api';
import type { RuntimeLog } from './types';

export function ProjectStatusBadge({ status }: Readonly<{ status?: string }>) {
  const value = String(status || 'active');
  const normalized = value.toLowerCase();
  const destructive = ['fail', 'reject', 'blocked'].some((signal) => normalized.includes(signal));
  const pending = ['queue', 'build', 'pending', 'pause', 'provision', 'delet'].some((signal) => normalized.includes(signal));
  const labels: Readonly<Record<string, string>> = {
    active: '활성', live: 'LIVE', ready: '준비됨', healthy: '정상', running: '실행 중', pending: '대기 중', queued: '대기열', building: '빌드 중', provisioning: '준비 중', failed: '실패', rejected: '거절됨', blocked: '차단됨', offline: '오프라인',
  };
  return <Badge data-status={value} variant={destructive ? 'destructive' : pending ? 'secondary' : 'outline'}>{labels[normalized] ?? value}</Badge>;
}

export function LoadIssues({ issues }: Readonly<{ issues: readonly DashboardLoadIssue[] }>) {
  if (issues.length === 0) return null;
  return (
    <Alert aria-live="polite" variant="destructive">
      <AlertTitle>일부 정보를 불러오지 못했습니다.</AlertTitle>
      <AlertDescription>
        <ul className="mt-raibit-xs list-disc pl-raibit-lg">
          {issues.map((issue, index) => <li key={`${issue.label}-${issue.status}-${index}`}>{issue.label}: {issue.message}</li>)}
        </ul>
        <p className="mt-raibit-sm">잠시 후 다시 시도해 주세요.</p>
      </AlertDescription>
    </Alert>
  );
}

export function MetricGrid({ items }: Readonly<{ items: readonly Readonly<{ label: string; value: string | number; detail: string }>[] }>) {
  return (
    <section aria-label="주요 지표" className="grid grid-cols-[repeat(auto-fit,minmax(min(13rem,100%),1fr))] gap-raibit-md">
      {items.map((item) => (
        <Card key={item.label} size="sm">
          <CardHeader><CardDescription>{item.label}</CardDescription><CardTitle className="text-display-md tabular-nums">{item.value}</CardTitle></CardHeader>
          <CardContent className="text-caption text-muted-foreground">{item.detail}</CardContent>
        </Card>
      ))}
    </section>
  );
}

export function Panel({ action, children, description, title }: Readonly<{ action?: ReactNode; children: ReactNode; description?: ReactNode; title: ReactNode }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle><h2>{title}</h2></CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function HubEmpty({ action, description, title }: Readonly<{ action?: ReactNode; description?: string; title: string }>) {
  return (
    <Empty className="min-h-48 border border-dashed border-border">
      <EmptyHeader><EmptyTitle>{title}</EmptyTitle>{description ? <EmptyDescription>{description}</EmptyDescription> : null}</EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

export function RuntimeLogViewer({ rows }: Readonly<{ rows: readonly RuntimeLog[] }>) {
  if (rows.length === 0) return <HubEmpty title="표시할 런타임 로그가 없습니다." description="서비스가 로그를 기록하면 이곳에 표시됩니다." />;
  return (
    <div className="max-h-[32rem] overflow-auto rounded-sm bg-inverse p-raibit-lg font-mono text-sm text-inverse-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40" role="log" aria-label="런타임 로그" data-runtime-log-viewport tabIndex={0}>
      {rows.map((row, index) => (
        <div className="grid min-w-0 gap-raibit-xs border-b border-white/10 py-raibit-sm last:border-0 lg:grid-cols-[10rem_5rem_minmax(0,1fr)]" key={row.id ?? index}>
          <span className="text-white/60">{row.createdAt ?? row.timestamp ?? '이벤트'}</span>
          <span className="text-white/70">{row.level ?? row.type ?? '정보'}</span>
          <span className="break-words [overflow-wrap:anywhere]">{row.line ?? row.message ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

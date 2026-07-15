import { Suspense, type ReactNode } from 'react';
import { FlashBanner } from './flash-banner';
import { Icon } from './icon';
import type { IconName } from './icon';

type JsonCardProps = {
  title: string;
  value: any;
};

type NavItemId = 'overview' | 'projects' | 'create-project' | 'github' | 'admin' | 'auth';

type ShellProps = {
  children: ReactNode;
  eyebrow?: string;
  orgLabel?: string;
  orgValue?: string;
  projectLabel?: string;
  projectValue?: string;
  active?: NavItemId;
  crumbs?: string;
  actions?: ReactNode;
};

const navItems: Array<{ id: NavItemId; label: string; href: string; icon: IconName }> = [
  { id: 'overview', label: '개요', href: '/', icon: 'squares-2x2' },
  { id: 'projects', label: '프로젝트', href: '/org/default/projects', icon: 'folder' },
  { id: 'create-project', label: '프로젝트 만들기', href: '/org/default/projects/new', icon: 'plus' },
  { id: 'github', label: 'GitHub 연결', href: '/github', icon: 'arrow-top-right-on-square' },
  { id: 'admin', label: '관리자', href: '/admin', icon: 'user-group' },
  { id: 'auth', label: '로그인', href: '/login', icon: 'shield-check' },
];

export function ConsoleShell({ children, eyebrow = '운영', orgLabel = '현재 워크스페이스', orgValue = 'RAIBITSERVER', projectLabel = '현재 프로젝트', projectValue = '전체 프로젝트', active = 'overview', crumbs = 'RAIBITSERVER / 운영 콘솔', actions }: ShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/"><span className="brand-mark">RS</span><span>RAIBITSERVER</span></a>
        <div className="switcher"><p className="switcher-label">{orgLabel}</p><div className="switcher-title">{orgValue}</div></div>
        <div className="switcher"><p className="switcher-label">{projectLabel}</p><div className="switcher-title">{projectValue}</div></div>
        <nav className="nav-group"><p className="nav-title">{eyebrow}</p>{navItems.map((item) => <a key={item.id} className={`nav-link ${active === item.id ? 'active' : ''}`} aria-current={active === item.id ? 'page' : undefined} href={item.href}><Icon name={item.icon} /><span>{item.label}</span><span>›</span></a>)}</nav>
      </aside>
      <main className="main">
        <div className="topbar"><div className="crumbs">{crumbs}</div><div className="toolbar">{actions}</div></div>
        <nav className="mobile-nav">{navItems.map((item) => <a key={item.id} className={`btn ${active === item.id ? 'active' : ''}`} aria-current={active === item.id ? 'page' : undefined} href={item.href}><Icon name={item.icon} /><span>{item.label}</span></a>)}</nav>
        <div className="flash-stack"><Suspense fallback={null}><FlashBanner /></Suspense></div>
        {children}
      </main>
    </div>
  );
}

export type LoadIssue = {
  label: string;
  message: string;
  status: number;
};

export function LoadErrorSummary({ issues }: { issues?: LoadIssue[] }) {
  if (!issues?.length) return null;
  return (
    <aside className="load-error-summary" role="alert" aria-live="polite">
      <strong>일부 정보를 불러오지 못했습니다.</strong>
      <ul>{issues.map((issue, index) => <li key={`${issue.label}-${issue.status}-${index}`}><span>{issue.label}</span>: {issue.message}</li>)}</ul>
      <p className="muted">나머지 정보는 계속 표시됩니다. 잠시 후 새로고침하거나 로그인 상태를 확인하세요.</p>
    </aside>
  );
}

export function JsonCard({ title, value }: JsonCardProps) {
  return (
    <article className="card">
      <div className="card-title"><h2>{title}</h2><span className="badge info">API</span></div>
      <pre className="code-panel" style={{ padding: 12 }}>{JSON.stringify(value, null, 2)}</pre>
    </article>
  );
}

type MetricItem = {
  label: string;
  value: number | string;
  detail?: string;
  tone?: 'ok' | 'info' | 'warn' | 'danger';
  progress?: number;
};

function clampProgress(progress?: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, Number(progress)));
}

export function MetricStrip({ items }: { items: MetricItem[] }) {
  return (
    <section className="metric-strip" aria-label="주요 지표">
      {items.map((item) => (
        <article className="metric-item" key={item.label} title={item.label}>
          <span className="metric-label">{item.label}</span>
          <strong className="metric-value">{item.value}</strong>
          <span className="metric-detail">{item.detail || '—'}</span>
          <div className={`metric-meter ${item.tone || 'ok'}`} aria-hidden="true">
            <i style={{ width: `${clampProgress(item.progress)}%` }} />
          </div>
        </article>
      ))}
    </section>
  );
}

const statusLabels: Record<string, string> = {
  active: '활성',
  ready: '준비됨',
  healthy: '정상',
  running: '실행 중',
  pending: '대기 중',
  queued: '대기열',
  building: '빌드 중',
  failed: '실패',
  rejected: '거절됨',
  blocked: '차단됨',
  offline: '오프라인',
};

export function StatusBadge({ status }: { status?: string }) {
  const text = String(status || 'active');
  return <span className={`badge ${statusTone(text)}`} data-status={text}><i />{statusLabels[text.toLowerCase()] || text}</span>;
}

function statusTone(status: string) {
  const lower = status.toLowerCase();
  if (['fail', 'reject', 'blocked'].some((signal) => lower.includes(signal))) return 'danger';
  if (['queue', 'build', 'pending', 'pause'].some((signal) => lower.includes(signal))) return 'warn';
  if (['ready', 'healthy', 'active', 'running', 'approved'].some((signal) => lower.includes(signal))) return 'ok';
  return 'info';
}

export function MetricCard({ title, value, detail, tone = 'info' }: { title: string; value: number | string; detail?: string; tone?: 'ok' | 'warn' | 'danger' | 'info' }) {
  return <article className="card"><div className="card-title"><h2>{title}</h2><span className={`badge ${tone}`}>실시간</span></div><strong className="metric-value">{value}</strong>{detail ? <p className="muted">{detail}</p> : null}</article>;
}

export function LogViewer({ rows, field = 'line', empty = '표시할 로그가 없습니다.' }: { rows: any[]; field?: string; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return <div className="log-viewer">{rows.map((row, index) => <div className="log-line" key={row.id || index}><span>{row.createdAt || row.timestamp || '이벤트'}</span><span className="info">{row.level || row.type || '정보'}</span><span>{row[field] || row.message || row.line || JSON.stringify(row)}</span></div>)}</div>;
}

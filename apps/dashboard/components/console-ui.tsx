import { Suspense, type ReactNode } from 'react';
import Image from 'next/image';
import { redirect } from 'next/navigation';
import { apiAction, dashboardApiContext, getJson } from '../lib/api';
import { consoleOrganizationLinks, resolveOrganizationRouteValue } from '../lib/console-navigation';
import { ConsoleSearch } from './console-search';
import { FlashBanner } from './flash-banner';
import { Icon } from './icon';
import type { IconName } from './icon';

type JsonCardProps = {
  title: string;
  value: any;
};

type NavItemId = 'overview' | 'projects' | 'create-project' | 'github' | 'guide' | 'admin';

type ShellProps = {
  children: ReactNode;
  eyebrow?: string;
  orgLabel?: string;
  orgValue?: string;
  orgRouteValue?: string;
  projectLabel?: string;
  projectValue?: string;
  projectId?: string;
  active?: NavItemId;
  crumbs?: string;
  actions?: ReactNode;
};

type SectionNavItem = {
  id: string;
  label: string;
  href: string;
  description?: string;
};

type NavItem = { id: NavItemId; label: string; href: string; icon: IconName };

export async function ConsoleShell({
  children,
  eyebrow = '운영',
  orgLabel = '현재 조직',
  orgValue = 'RAIBITSERVER',
  orgRouteValue,
  projectLabel = '현재 프로젝트',
  projectValue = '전체 프로젝트',
  projectId,
  active = 'overview',
}: ShellProps) {
  const context = await dashboardApiContext();
  const me = context.token
    ? await getJson('/auth/me', { user: null, subject: null }, context)
    : { ok: false, status: 401, body: { user: null, subject: null } };
  if (!me.ok) redirect('/login?error=session_expired');
  const user = me.body?.user;
  const subject = me.body?.subject;
  const isAdmin = me.ok && String(user?.role || subject?.userRole || '').toUpperCase() === 'ADMIN';
  const resolvedOrgRouteValue = resolveOrganizationRouteValue({
    requested: orgRouteValue,
    subject,
    memberships: me.body?.memberships,
  });
  const organizationLinks = consoleOrganizationLinks(resolvedOrgRouteValue);
  const navItems: NavItem[] = [
    { id: 'overview', label: '개요', href: '/console', icon: 'squares-2x2' },
    { id: 'projects', label: '프로젝트', href: organizationLinks.projects, icon: 'folder' },
    { id: 'create-project', label: '프로젝트 만들기', href: organizationLinks.createProject, icon: 'plus' },
    { id: 'github', label: 'GitHub 연결', href: '/github', icon: 'arrow-top-right-on-square' },
    { id: 'guide', label: '사용 안내', href: '/guide', icon: 'command-line' },
    ...(isAdmin ? [{ id: 'admin' as const, label: '관리자', href: '/admin', icon: 'user-group' as IconName }] : []),
  ];
  const projectBase = projectId && resolvedOrgRouteValue
    ? `${organizationLinks.projects}/${encodeURIComponent(projectId)}`
    : '';
  const projectSearchItems = projectBase ? [
    { label: '프로젝트 현황', href: `${projectBase}?view=overview`, group: '현재 프로젝트', keywords: 'overview status 현황' },
    { label: '서비스', href: `${projectBase}?view=services`, group: '현재 프로젝트', keywords: 'service container 서비스' },
    { label: '배포', href: `${projectBase}?view=deployments`, group: '현재 프로젝트', keywords: 'deployment release 배포' },
    { label: '리소스', href: `${projectBase}?view=resources`, group: '현재 프로젝트', keywords: 'resource database storage 리소스' },
    { label: '로그', href: `${projectBase}?view=logs`, group: '현재 프로젝트', keywords: 'log runtime 로그' },
    { label: '설정', href: `${projectBase}?view=settings`, group: '현재 프로젝트', keywords: 'settings config 설정' },
  ] : [];
  const searchItems = [
    ...navItems.map((item) => ({ label: item.label, href: item.href, group: '메뉴', keywords: item.id })),
    ...projectSearchItems,
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/console"><span className="brand-mark"><Image src="/raibit-logo.jpg" alt="" width={27} height={27} /></span><span>RAIBIT SERVER</span></a>
        <div className="switcher"><p className="switcher-label">{orgLabel}</p><div className="switcher-title">{orgValue}</div></div>
        <div className="switcher"><p className="switcher-label">{projectLabel}</p><div className="switcher-title">{projectValue}</div></div>
        <nav className="nav-group"><p className="nav-title">{eyebrow}</p>{navItems.map((item) => <a key={item.id} className={`nav-link ${active === item.id ? 'active' : ''}`} aria-current={active === item.id ? 'page' : undefined} href={item.href}><Icon name={item.icon} /><span>{item.label}</span><span>›</span></a>)}</nav>
        <div className="sidebar-account"><span>{user?.email || '로그인 사용자'}</span><form method="post" action={apiAction('/auth/logout')}><input type="hidden" name="_returnTo" value="/login" /><button className="btn btn-ghost" type="submit">로그아웃</button></form></div>
      </aside>
      <main className="main">
        <div className="topbar"><div className="toolbar" aria-label="콘솔 도구"><ConsoleSearch items={searchItems} /><a className={`topbar-guide ${active === 'guide' ? 'active' : ''}`} href="/guide"><Icon name="command-line" /><span>사용 설명서</span></a></div></div>
        <div className="flash-stack"><Suspense fallback={null}><FlashBanner /></Suspense></div>
        {children}
      </main>
    </div>
  );
}

export function SectionNav({ items, current, label, variant = 'tabs' }: { items: SectionNavItem[]; current: string; label: string; variant?: 'tabs' | 'steps' }) {
  return (
    <nav className={`section-nav section-nav-${variant}`} aria-label={label}>
      {items.map((item, index) => {
        const active = item.id === current;
        return <a key={item.id} className={`section-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} aria-label={item.description ? `${item.label}: ${item.description}` : item.label} href={item.href}>{variant === 'steps' ? <span className="section-nav-index">{index + 1}</span> : null}<span><strong>{item.label}</strong>{item.description ? <small>{item.description}</small> : null}</span></a>;
      })}
    </nav>
  );
}

export type LoadIssue = {
  label: string;
  message: string;
  status: number;
};

export function LoadErrorSummary({ issues }: { issues?: LoadIssue[] }) {
  if (!issues?.length) return null;
  return <aside className="load-error-summary" role="alert" aria-live="polite"><strong>일부 정보를 불러오지 못했습니다.</strong><ul>{issues.map((issue, index) => <li key={`${issue.label}-${issue.status}-${index}`}><span>{issue.label}</span>: {issue.message}</li>)}</ul><p className="muted">잠시 후 다시 시도해 주세요.</p></aside>;
}

export function JsonCard({ title, value }: JsonCardProps) {
  return <article className="console-data-block"><div className="card-title"><h2>{title}</h2><span className="badge info">API</span></div><pre className="code-panel" style={{ padding: 12 }}>{JSON.stringify(value, null, 2)}</pre></article>;
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
  return <section className="metric-strip" aria-label="주요 지표">{items.map((item) => <article className="metric-item" key={item.label} title={item.label}><span className="metric-label">{item.label}</span><strong className="metric-value">{item.value}</strong><span className="metric-detail">{item.detail || '—'}</span>{Number.isFinite(item.progress) ? <div className={`metric-meter ${item.tone || 'ok'}`} aria-hidden="true"><i style={{ width: `${clampProgress(item.progress)}%` }} /></div> : null}</article>)}</section>;
}

const statusLabels: Record<string, string> = {
  active: '활성',
  live: 'LIVE',
  ready: '준비됨',
  healthy: '정상',
  running: '실행 중',
  pending: '대기 중',
  queued: '대기열',
  building: '빌드 중',
  provisioning: '준비 중',
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
  if (['queue', 'build', 'pending', 'pause', 'provision'].some((signal) => lower.includes(signal))) return 'warn';
  if (['live', 'ready', 'healthy', 'active', 'running', 'approved'].some((signal) => lower.includes(signal))) return 'ok';
  return 'info';
}

export function MetricCard({ title, value, detail, tone = 'info' }: { title: string; value: number | string; detail?: string; tone?: 'ok' | 'warn' | 'danger' | 'info' }) {
  return <article className="metric-item"><span className="metric-label">{title}</span><strong className="metric-value">{value}</strong>{detail ? <span className={`metric-detail ${tone}`}>{detail}</span> : null}</article>;
}

export function LogViewer({ rows, field = 'line', empty = '표시할 로그가 없습니다.' }: { rows: any[]; field?: string; empty?: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return <div className="log-viewer">{rows.map((row, index) => <div className="log-line" key={row.id || index}><span>{row.createdAt || row.timestamp || '이벤트'}</span><span className="info">{row.level || row.type || '정보'}</span><span>{row[field] || row.message || row.line || JSON.stringify(row)}</span></div>)}</div>;
}

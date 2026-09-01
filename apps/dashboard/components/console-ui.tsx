import { Suspense, type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { buttonVariants } from '@/components/ui/button';
import { apiAction, dashboardApiContext, getJson } from '../lib/api';
import { consoleOrganizationLinks, resolveOrganizationRouteValue } from '../lib/console-navigation';
import { cn } from '../lib/utils';
import { ConsoleSearch } from './console-search';
import { ConsoleMobileNav } from './console-mobile-nav';
import { ThemeMenu } from './theme-menu';
import { Brand } from './brand';
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
  const logoutAction = apiAction('/auth/logout');

  return (
    <div className="grid h-dvh min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background md:grid-cols-[16.5rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]" data-console-shell>
      <aside className="hidden min-h-0 flex-col border-r border-border bg-card md:flex" aria-label="콘솔 사이드바">
        <a className="flex min-h-16 items-center gap-3 border-b border-border px-5 text-sm font-medium text-foreground" href="/console">
          <Brand height={28} width={28} />
          <span>RAIBIT SERVER</span>
        </a>
        <div className="flex flex-col gap-3 border-b border-border p-4">
          <div className="min-w-0 rounded-md border border-border bg-background px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{orgLabel}</p>
            <p className="truncate text-sm font-medium text-foreground" title={orgValue}>{orgValue}</p>
          </div>
          <div className="min-w-0 px-3 py-1">
            <p className="text-xs text-muted-foreground">{projectLabel}</p>
            <p className="truncate text-sm text-foreground" title={projectValue}>{projectValue}</p>
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 p-3" aria-label="콘솔 메뉴">
          <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{eyebrow}</p>
          {navItems.map((item) => {
            const current = active === item.id;
            return (
              <a key={item.id} className={cn('flex min-h-9 items-center gap-2 rounded-sm border-l-2 px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25', current ? 'border-primary bg-primary-soft text-primary' : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground')} aria-current={current ? 'page' : undefined} href={item.href}>
                <Icon name={item.icon} />
                <span className="truncate">{item.label}</span>
              </a>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <p className="truncate px-2 pb-2 text-xs text-muted-foreground" title={user?.email || '로그인 사용자'}>{user?.email || '로그인 사용자'}</p>
          <form method="post" action={apiAction('/auth/logout')}><input type="hidden" name="_returnTo" value="/login" /><button className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'w-full justify-start')} type="submit">로그아웃</button></form>
        </div>
      </aside>
      <header className="flex min-w-0 items-center justify-between gap-2 border-b border-border bg-background px-3 py-2 md:hidden">
        <ConsoleMobileNav active={active} eyebrow={eyebrow} logoutAction={logoutAction} navItems={navItems} orgLabel={orgLabel} orgValue={orgValue} projectLabel={projectLabel} projectValue={projectValue} userEmail={user?.email || '로그인 사용자'} />
        <div className="flex shrink-0 items-center gap-2" aria-label="모바일 콘솔 도구">
          <ConsoleSearch compact items={searchItems} />
          <ThemeMenu />
        </div>
      </header>
      <main id="main-content" className="min-h-0 min-w-0 overflow-y-auto overscroll-y-contain md:col-start-2 md:row-start-1">
        <header className="sticky top-0 z-10 hidden min-h-16 items-center justify-between gap-4 border-b border-border bg-background/95 px-6 supports-backdrop-filter:backdrop-blur-sm md:flex">
          <div className="hidden min-w-0 lg:block">
            <p className="text-xs text-muted-foreground">{eyebrow}</p>
            <p className="truncate text-sm font-medium text-foreground" title={projectValue}>{projectValue}</p>
          </div>
          <div className="flex items-center gap-2" aria-label="콘솔 도구">
            <ConsoleSearch items={searchItems} />
            <a className={buttonVariants({ variant: active === 'guide' ? 'secondary' : 'ghost', size: 'sm' })} href="/guide"><Icon name="command-line" /><span>사용 설명서</span></a>
            <ThemeMenu />
          </div>
        </header>
        <div className="px-4 pt-3 md:px-6"><Suspense fallback={null}><FlashBanner /></Suspense></div>
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
  return <div className="load-error-summary" role="alert" aria-live="polite" aria-atomic="true"><strong>일부 정보를 불러오지 못했습니다.</strong><ul className="text-foreground">{issues.map((issue, index) => <li key={`${issue.label}-${issue.status}-${index}`}><span>{issue.label}</span>: {issue.message}</li>)}</ul><p className="text-foreground">잠시 후 다시 시도해 주세요.</p></div>;
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

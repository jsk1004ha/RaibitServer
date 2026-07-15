# RAIBITSERVER Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild every RAIBITSERVER dashboard route as a compact Korean-first operations console using the approved Stitch/ASTRYX direction and complete official Heroicons SVG paths while preserving all API-backed behavior.

**Architecture:** Keep the existing Next.js server-component data flow and direct form contracts. Add a dependency-free typed SVG icon boundary, expand the existing shared console components, and replace the global CSS presentation layer with the tokens and responsive rules in `DESIGN.md`. Route files retain their current API calls and technical markers while their visible copy and layout become Korean and consistent.

**Tech Stack:** Next.js 16 App Router, React 19 server components, TypeScript 6, plain global CSS, Node.js built-in test runner, inline Heroicons 24px outline SVG.

---

## File structure and ownership

- Create `apps/dashboard/components/icon.tsx`: the only source of dashboard SVG paths and icon accessibility behavior.
- Modify `apps/dashboard/components/console-ui.tsx`: shell, Korean navigation, status mapping, metric strip, panel headings, logs, and empty states.
- Modify `apps/dashboard/components/project-card.tsx`: compact project row/panel presentation without changing its input contract.
- Modify `apps/dashboard/app/globals.css`: design tokens, shell, components, tables, forms, log panels, responsive behavior, and reduced-motion rules.
- Modify `apps/dashboard/app/layout.tsx`: Korean metadata only; keep the fixed dark theme.
- Modify each `apps/dashboard/app/**/page.tsx`: Korean copy and approved page composition only.
- Modify `tests/dashboard-console.test.js`: preserve API/behavior contract checks while replacing obsolete English UI markers.
- Create `tests/dashboard-design.test.js`: static contract checks for icons, Korean shell copy, compact KPI rules, and responsive breakpoints.

Do not modify `apps/dashboard/lib/api.ts`, `apps/dashboard/middleware.ts`, dashboard route handlers, API services, Prisma, Helm, Go services, or package manifests for this redesign. Those files contain pre-existing work that must remain intact.

Because several route files already contain user-owned uncommitted changes, every task must compare the current file before editing and preserve those changes. Do not commit a file containing unrelated pre-existing hunks. New isolated files may be committed with Lore trailers; overlapping route/CSS edits remain uncommitted unless the user later asks to stage them.

### Task 1: Lock the approved visual contract with failing tests

**Files:**
- Create: `tests/dashboard-design.test.js`
- Modify: `tests/dashboard-console.test.js`

- [ ] **Step 1: Add the failing design-system test**

Create `tests/dashboard-design.test.js` with these exact assertions:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (path) => fs.readFile(new URL(path, import.meta.url), 'utf8');

test('dashboard shell is Korean-first and uses typed Heroicons', async () => {
  const [shell, icons] = await Promise.all([
    read('../apps/dashboard/components/console-ui.tsx'),
    read('../apps/dashboard/components/icon.tsx'),
  ]);

  for (const label of ['개요', '프로젝트', '배포', '리소스', '콘솔', 'GitHub 연결', '관리자']) {
    assert.ok(shell.includes(label), `${label} navigation label missing`);
  }
  for (const icon of ['squares-2x2', 'folder', 'rocket-launch', 'circle-stack', 'command-line', 'cog-6-tooth', 'magnifying-glass', 'bell', 'plus', 'server-stack']) {
    assert.ok(icons.includes(`'${icon}'`), `${icon} Heroicon missing`);
  }
  assert.match(icons, /viewBox="0 0 24 24"/);
  assert.match(icons, /strokeWidth=\{1\.5\}/);
  assert.doesNotMatch(shell, />Dashboard</);
  assert.doesNotMatch(shell, />Create project</);
});

test('dashboard CSS keeps KPI surfaces horizontal and compact', async () => {
  const css = await read('../apps/dashboard/app/globals.css');
  for (const token of ['--color-canvas: #0b0e12', '--color-primary: #68df88', '--sidebar: 238px']) {
    assert.ok(css.includes(token), `${token} token missing`);
  }
  assert.match(css, /\.metric-strip\s*\{/);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(150px,\s*1fr\)\)/);
  assert.match(css, /min-height:\s*78px/);
  assert.match(css, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(css, /overflow-x:\s*auto/);
});

test('primary dashboard pages expose Korean visible headings', async () => {
  const files = await Promise.all([
    read('../apps/dashboard/app/page.tsx'),
    read('../apps/dashboard/app/admin/page.tsx'),
    read('../apps/dashboard/app/github/page.tsx'),
    read('../apps/dashboard/app/login/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
    read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
  ]);
  const combined = files.join('\n');
  for (const label of ['운영 현황', '사용자 관리', '저장소 연결', '로그인', '프로젝트 만들기', '배포 상세', '리소스 콘솔']) {
    assert.ok(combined.includes(label), `${label} visible heading missing`);
  }
});
```

- [ ] **Step 2: Update obsolete English UI assertions without weakening API checks**

In the first test in `tests/dashboard-console.test.js`, keep the API/data markers and replace visible English markers with Korean equivalents:

```js
for (const marker of [
  'loadProjectConsole', '/deployments', '/console/query',
  'sourceType', 'imageUrl', 'dockerfilePath',
  '서비스 만들기', '리소스 추가', '운영 환경에 배포',
  '미리보기 배포', '빌드 로그', '런타임 로그',
]) {
  assert.ok(detail.includes(marker), `${marker} missing from project console page`);
}
```

Do not remove the second test's route markers such as `/auth/login`, `/admin/users/`, `/console/command`, `/status`, `/cancel`, or `/rollback`.

- [ ] **Step 3: Run the tests and confirm the intended failure**

Run:

```sh
node --test tests/dashboard-design.test.js tests/dashboard-console.test.js
```

Expected: `dashboard-design.test.js` fails because `icon.tsx`, the Korean shell labels, and compact CSS tokens do not exist yet. Existing API route assertions must continue to pass.

- [ ] **Step 4: Commit only the isolated new test if safe**

If `tests/dashboard-design.test.js` is the only staged file:

```sh
git add tests/dashboard-design.test.js
git diff --cached --check
git commit -m "Guard the approved dashboard direction before implementation" \
  -m "Constraint: Preserve API behavior while changing the visible console language and structure" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: Confirmed the new contract fails before implementation"
```

Leave `tests/dashboard-console.test.js` unstaged if it contains unrelated user changes.

### Task 2: Add the typed official Heroicons boundary

**Files:**
- Create: `apps/dashboard/components/icon.tsx`
- Test: `tests/dashboard-design.test.js`

- [ ] **Step 1: Implement the icon component and complete path map**

Create the file with this public interface and path structure:

```tsx
type IconName =
  | 'squares-2x2'
  | 'folder'
  | 'rocket-launch'
  | 'circle-stack'
  | 'command-line'
  | 'cog-6-tooth'
  | 'magnifying-glass'
  | 'bell'
  | 'plus'
  | 'server-stack'
  | 'user-group'
  | 'arrow-top-right-on-square'
  | 'shield-check'
  | 'exclamation-triangle';

type IconProps = {
  name: IconName;
  className?: string;
  label?: string;
};

const iconPaths: Record<IconName, readonly string[]> = {
  'squares-2x2': ['M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z'],
  'folder': ['M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z'],
  'rocket-launch': ['M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41m5.96 5.96a14.926 14.926 0 0 1-5.841 2.58m-.119-8.54a6 6 0 0 0-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 0 0-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 0 1-2.448-2.448 14.9 14.9 0 0 1 .06-.312m-2.24 2.39a4.493 4.493 0 0 0-1.757 4.306 4.493 4.493 0 0 0 4.306-1.758M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z'],
  'circle-stack': ['M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125'],
  'command-line': ['m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z'],
  'cog-6-tooth': ['M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  'magnifying-glass': ['m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z'],
  'bell': ['M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0'],
  'plus': ['M12 4.5v15m7.5-7.5h-15'],
  'server-stack': ['M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z'],
  'user-group': ['M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z'],
  'arrow-top-right-on-square': ['M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25'],
  'shield-check': ['M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z'],
  'exclamation-triangle': ['M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z'],
};

export function Icon({ name, className = '', label }: IconProps) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    >
      {iconPaths[name].map((path) => (
        <path key={path} strokeLinecap="round" strokeLinejoin="round" d={path} />
      ))}
    </svg>
  );
}

export type { IconName };
```

Keep every path byte-for-byte equivalent to the official optimized 24px outline source. Never shorten a path for readability.

- [ ] **Step 2: Verify the icon contract**

Run:

```sh
node --test tests/dashboard-design.test.js
pnpm --filter @raibitserver/dashboard typecheck
```

Expected: icon-name, `viewBox`, and `strokeWidth` assertions pass; shell/CSS/page assertions still fail. Typecheck reports no invalid SVG attributes.

- [ ] **Step 3: Commit the isolated component**

```sh
git add apps/dashboard/components/icon.tsx tests/dashboard-design.test.js
git diff --cached --check
git commit -m "Keep dashboard icons trustworthy and dependency free" \
  -m "Constraint: Use complete official Heroicons paths without adding a package" \
  -m "Rejected: Abbreviated paths | they rendered as broken symbols in the approved design review" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: Dashboard design contract and dashboard TypeScript check"
```

### Task 3: Rebuild the shared shell and display primitives

**Files:**
- Modify: `apps/dashboard/components/console-ui.tsx`
- Modify: `apps/dashboard/components/project-card.tsx`
- Test: `tests/dashboard-design.test.js`

- [ ] **Step 1: Replace navigation data with stable Korean labels and icon names**

Use stable `id` values for `active`, so changing visible labels never breaks active-state matching:

```tsx
const navItems: Array<{ id: string; label: string; href: string; icon: IconName }> = [
  { id: 'overview', label: '개요', href: '/', icon: 'squares-2x2' },
  { id: 'projects', label: '프로젝트', href: '/org/default/projects', icon: 'folder' },
  { id: 'create-project', label: '프로젝트 만들기', href: '/org/default/projects/new', icon: 'plus' },
  { id: 'github', label: 'GitHub 연결', href: '/github', icon: 'arrow-top-right-on-square' },
  { id: 'admin', label: '관리자', href: '/admin', icon: 'user-group' },
  { id: 'auth', label: '로그인', href: '/login', icon: 'shield-check' },
];
```

Import `Icon` and `IconName`. Set shell defaults to `active="overview"`, `eyebrow="운영"`, `orgLabel="현재 워크스페이스"`, `projectLabel="현재 프로젝트"`, and `projectValue="전체 프로젝트"`.

- [ ] **Step 2: Add the compact metric strip**

Add this component to `console-ui.tsx`:

```tsx
type MetricItem = {
  label: string;
  value: number | string;
  detail?: string;
  tone?: 'ok' | 'info' | 'warn' | 'danger';
  progress?: number;
};

export function MetricStrip({ items }: { items: MetricItem[] }) {
  return (
    <section className="metric-strip" aria-label="주요 지표">
      {items.map((item) => (
        <article className="metric-item" key={item.label} title={item.label}>
          <span className="metric-label">{item.label}</span>
          <strong className="metric-value">{item.value}</strong>
          <span className="metric-detail">{item.detail}</span>
          <span className={`metric-meter ${item.tone || 'ok'}`} aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, item.progress ?? 0))}%` }} />
          </span>
        </article>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Koreanize status and log fallbacks without changing raw log messages**

Map known status values to Korean labels in `StatusBadge`, but keep the raw status in `data-status`:

```tsx
const statusLabels: Record<string, string> = {
  active: '활성', ready: '준비됨', healthy: '정상', running: '실행 중',
  pending: '대기 중', queued: '대기열', building: '빌드 중',
  failed: '실패', rejected: '거절됨', blocked: '차단됨', offline: '오프라인',
};

return <span data-status={text} className={`badge ${statusTone(text)}`}><i />{statusLabels[text.toLowerCase()] || text}</span>;
```

Set `LogViewer`'s default empty message to `표시할 로그가 없습니다.` and default level label to `정보`. Do not translate `row.message` or `row.line`.

- [ ] **Step 4: Make project cards compact while preserving props**

Keep `ProjectCardProps` unchanged. Render a `project-row-card` with a folder icon, Korean counts (`서비스 N개 · 리소스 N개`), and `콘솔 열기 →`.

- [ ] **Step 5: Verify shared components**

```sh
node --test tests/dashboard-design.test.js tests/dashboard-console.test.js
pnpm --filter @raibitserver/dashboard typecheck
```

Expected: shell and icon assertions pass. Page/CSS assertions remain red until later tasks.

### Task 4: Replace the global presentation layer with compact tokens

**Files:**
- Modify: `apps/dashboard/app/globals.css`
- Modify: `apps/dashboard/app/layout.tsx`
- Test: `tests/dashboard-design.test.js`

- [ ] **Step 1: Replace root theme tokens**

Use the approved fixed dark tokens:

```css
:root {
  --color-canvas: #0b0e12;
  --color-rail: #0e1217;
  --color-surface: #151a20;
  --color-surface-raised: #1b2128;
  --color-surface-strong: #222932;
  --color-border: #2b333c;
  --color-text: #eef2f6;
  --color-text-soft: #aeb7c0;
  --color-text-muted: #87929e;
  --color-primary: #68df88;
  --color-primary-ink: #08250f;
  --color-info: #64b9ee;
  --color-warning: #e8ad4a;
  --color-danger: #ff857d;
  --font-body: "Noto Sans KR", Inter, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
  --sidebar: 238px;
  --radius-panel: 13px;
  --radius-control: 9px;
}
```

Delete the duplicate light/dark token blocks and map legacy names only when an unchanged route still requires them.

- [ ] **Step 2: Implement the compact KPI and action geometry**

```css
.metric-strip {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  min-height: 78px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
}

.metric-item {
  min-width: 150px;
  min-height: 78px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto auto auto;
  align-items: center;
  column-gap: 12px;
  padding: 11px 15px;
  border-right: 1px solid var(--color-border);
}

.quick-action {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface-raised);
}
```

Ensure the final metric child has no right border and labels use one-line ellipsis.

- [ ] **Step 3: Implement responsive behavior before content becomes narrow**

At `1180px`, move secondary panels below primary content and allow quick actions to form a horizontal row. At `900px`, replace the sidebar with `mobile-nav`. At `720px`, use `display: flex; overflow-x: auto; scroll-snap-type: x proximity` for `.metric-strip`; never stack KPI items vertically.

- [ ] **Step 4: Add accessibility and motion rules**

```css
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.icon { width: 18px; height: 18px; flex: 0 0 auto; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

- [ ] **Step 5: Koreanize metadata**

Set `layout.tsx` metadata description to `클럽, 학교, 소규모 팀을 위한 컨테이너 기반 PaaS 및 DBaaS.`.

- [ ] **Step 6: Run static and build checks**

```sh
node --test tests/dashboard-design.test.js
pnpm --filter @raibitserver/dashboard typecheck
pnpm --filter @raibitserver/dashboard build
```

Expected: token, geometry, breakpoint, icon, and shell assertions pass; only untranslated page assertions may remain.

### Task 5: Recompose overview and project-list routes

**Files:**
- Modify: `apps/dashboard/app/page.tsx`
- Modify: `apps/dashboard/app/org/[orgSlug]/projects/page.tsx`
- Modify: `apps/dashboard/components/project-card.tsx`
- Test: `tests/dashboard-design.test.js`
- Test: `tests/dashboard-console.test.js`

- [ ] **Step 1: Convert the home page to the approved operations layout**

Keep `loadDashboardOverview`, `createOrgSlug`, `apiAction('/health')`, and all current dynamic values. Use:

```tsx
<ConsoleShell active="overview" orgValue={createOrgSlug} crumbs={`${createOrgSlug} / 운영 현황`}>
  <header className="page-header">
    <div><p className="eyebrow">RAIBITSERVER · 제어 영역</p><h1 className="page-title">운영 현황</h1><p className="page-subtitle">프로젝트, 배포, 관리형 리소스 상태를 확인하세요.</p></div>
    <StatusBadge status={health ? 'healthy' : 'offline'} />
  </header>
  <MetricStrip items={[
    { label: '운영 중인 프로젝트', value: projects.length, detail: '제어 영역 기준', progress: Math.min(projects.length * 10, 100) },
    { label: 'GitHub 연결', value: state.github?.integrations?.length || 0, detail: '설치 및 저장소', tone: 'info', progress: 60 },
    { label: '사용량 기록', value: state.usage?.usage?.length || 0, detail: '현재 할당량', tone: 'warn', progress: 42 },
  ]} />
</ConsoleShell>
```

Below the strip, place project consoles and API/runtime activity in the primary column; place four compact quick actions and control-plane metadata in the secondary column.

- [ ] **Step 2: Convert the project list to compact rows**

Use `active="projects"`, visible heading `프로젝트`, button `프로젝트 만들기`, and empty-state action `첫 프로젝트 만들기`. Preserve filtering by `orgSlug` and each dynamic project link.

- [ ] **Step 3: Run focused tests**

```sh
node --test tests/dashboard-design.test.js tests/dashboard-console.test.js
pnpm --filter @raibitserver/dashboard typecheck
```

Expected: overview/list Korean headings pass, project links still avoid `/org/default/projects/new`, and API markers remain green.

### Task 6: Recompose project creation and project detail

**Files:**
- Modify: `apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx`
- Modify: `apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx`
- Test: `tests/dashboard-console.test.js`

- [ ] **Step 1: Koreanize the project creation workflow**

Preserve `apiAction('/projects')`, all input names, `sourceType`, image, Dockerfile, build context, desired-state preview, and quota preview. Map visible tabs to `1 소스`, `2 서비스`, `3 리소스`; labels to `프로젝트 이름`, `조직`, `저장소 URL`, `브랜치`, `Dockerfile 경로`, `빌드 컨텍스트`, `서비스 유형`, `데이터베이스`, `캐시`; and submit to `프로젝트 만들기`.

- [ ] **Step 2: Koreanize project detail without changing deferred data loading**

Preserve the current user-owned optimization that leaves build logs, events, runtime logs, and resource consoles deferred to detail routes. Use visible labels:

```text
프로젝트 콘솔 / 새 서비스 / 배포
개요 / 서비스 / 배포 / 리소스 / 도메인 / 환경 변수 / 감사 / 설정
서비스 만들기 / Dockerfile 우선
서비스와 배포 / 운영 환경에 배포 / 미리보기 만들기
배포 내역 / 미리보기 배포
리소스 추가 / 관리형 리소스
위험 영역 / 감사 로그 필수
빌드 로그 / 배포 이벤트 / 런타임 로그 / 상세 화면에서 불러오기
```

Keep every `apiAction` URL, form method, hidden `deploymentType`, input name, and detail link unchanged.

- [ ] **Step 3: Replace the three metric cards with one `MetricStrip`**

Use `서비스`, `리소스`, `배포` items and keep preview count in the deployment detail text.

- [ ] **Step 4: Verify functional markers**

```sh
node --test tests/dashboard-console.test.js tests/dashboard-design.test.js
pnpm --filter @raibitserver/dashboard typecheck
```

Expected: project console API/form markers and new Korean markers all pass.

### Task 7: Recompose deployment and resource operations screens

**Files:**
- Modify: `apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx`
- Modify: `apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx`
- Test: `tests/dashboard-console.test.js`

- [ ] **Step 1: Recompose deployment detail**

Keep `Promise.all`, deployment/log/event API reads, `/status`, `/cancel`, `/rollback`, form ids, image inputs, and failure fields. Use heading `배포 상세`, sections `상태와 이미지`, `빌드 로그`, `배포 이벤트`, `롤백 확인`, `배포 취소`, and actions `프로젝트 콘솔`, `롤백`, `상태 업데이트`, `배포 취소`.

- [ ] **Step 2: Recompose resource console**

Keep engine-specific defaults, `/console/query`, `/console/command`, `/provision`, `/attach`, confirmation checkbox, and provider-owned secret behavior. Use heading `리소스 콘솔`, tabs `스키마`, `쿼리`, `백업`, `연결`, and actions `자격 증명 교체`, `쿼리 실행`, `공급자 명령 실행`, `프로비저닝 계획 만들기`, `서비스에 연결`.

- [ ] **Step 3: Verify operational routes**

```sh
node --test tests/dashboard-console.test.js
pnpm --filter @raibitserver/dashboard typecheck
```

Expected: every operational API marker remains present and all visible operational headings are Korean.

### Task 8: Recompose GitHub, admin, and authentication screens

**Files:**
- Modify: `apps/dashboard/app/github/page.tsx`
- Modify: `apps/dashboard/app/admin/page.tsx`
- Modify: `apps/dashboard/app/login/page.tsx`
- Test: `tests/dashboard-console.test.js`
- Test: `tests/dashboard-design.test.js`

- [ ] **Step 1: Recompose GitHub integration**

Keep all current integration, import, attach, and sync API paths. Use heading `저장소 연결과 미리보기 배포`; sections `GitHub 연결`, `저장소 가져오기`, `서비스에 저장소 연결`, `저장소 정보 동기화`; and concise Korean status descriptions. Do not translate repository names, webhook identifiers, or API route evidence.

- [ ] **Step 2: Recompose admin**

Keep approval, rejection, quota, and audit form actions. Use heading `사용자 관리`; sections `사용자`, `할당량 편집`, `거절 확인`; actions `클럽 회원으로 승인`, `일반 사용자로 승인`, `거절`, `할당량 저장`. Keep account-type hidden values unchanged.

- [ ] **Step 3: Recompose authentication**

Preserve the user-owned same-origin `apiAction` change and all auth endpoints. Use `로그인`, `가입 신청`, `이메일 인증`, `인증 코드 다시 보내기`, `GitHub 연결`, and `GitHub로 계속하기`. Keep the secure signup explanation accurate: the verification code creates the verified account, and later approval controls account capabilities.

- [ ] **Step 4: Run design and route tests**

```sh
node --test tests/dashboard-design.test.js tests/dashboard-console.test.js
pnpm --filter @raibitserver/dashboard typecheck
```

Expected: all design and API marker tests pass.

### Task 9: Full verification and visual QA

**Files:**
- Modify only if verification finds a scoped defect in the files above.
- Update: `.omx/state/dashboard-design/ralph-progress.json`

- [ ] **Step 1: Run dashboard-focused verification**

```sh
pnpm --filter @raibitserver/dashboard test
pnpm --filter @raibitserver/dashboard typecheck
pnpm --filter @raibitserver/dashboard build
node --test tests/dashboard-design.test.js tests/dashboard-console.test.js tests/dashboard-tsconfig.test.js
```

Expected: all commands exit 0.

- [ ] **Step 2: Run repository verification required by `AGENTS.md`**

```sh
npm test
node scripts/check-structure.js
node src/cli.js validate examples/project.json
node src/cli.js manifest examples/project.json > raibitserver-manifest.json
node src/cli.js compose examples/docker-compose.yml > raibitserver-compose-plan.json
```

Expected: all commands exit 0. Remove the two generated root JSON files after confirming valid JSON; do not stage them.

- [ ] **Step 3: Run Go verification when available**

```sh
go test ./...
```

Run from each of `services/orchestrator`, `services/builder`, and `services/provisioner` that has a `go.mod`. Expected: exit 0, or report Go as unavailable without claiming Go verification.

- [ ] **Step 4: Capture responsive screenshots**

Start the dashboard with the existing development command, then capture:

- `/` at 1440×900
- `/` at 1180×820
- `/` at 390×844
- `/org/<available-org>/projects` at 1440×900
- one project detail at 1440×900
- one deployment detail and resource console at 1440×900 when seed data provides routes
- `/github`, `/admin`, and `/login` at 1440×900

Verify that KPI items remain a horizontal strip, Heroicons are complete, Korean labels do not wrap into narrow columns, and secondary panels move below the main area before 1180px.

- [ ] **Step 5: Run `visual-verdict` for every screenshot iteration**

Compare against the approved v4 companion mockup and supplied Stitch reference screens. Persist this shape in `.omx/state/dashboard-design/ralph-progress.json`:

```json
{
  "scope": "dashboard-design",
  "score": 90,
  "passed": true,
  "verdict": "pass",
  "reasoning": "Compact Korean console matches the approved layout and complete icon treatment.",
  "suggestions": [],
  "next_actions": ["final verification report"]
}
```

If any score is below 90, fix the concrete differences and recapture before continuing.

- [ ] **Step 6: Review the final diff without staging user-owned changes**

```sh
git diff --check
git status --short
git diff -- apps/dashboard tests/dashboard-console.test.js tests/dashboard-design.test.js DESIGN.md
```

Expected: no whitespace errors. Report pre-existing unrelated changes separately. Do not commit or stage overlapping dirty files without explicit user direction.

## Plan self-review

- Spec coverage: Korean copy, compact spacing, horizontal KPI behavior, official full Heroicons paths, every dashboard route, status/error states, accessibility, responsive breakpoints, automated tests, and visual verification are mapped to tasks.
- Completion scan: every implementation and error-handling step is concrete; no deferred or unnamed work remains.
- Type consistency: `IconName`, `Icon`, `MetricItem`, and `MetricStrip` names and props remain consistent across all tasks.
- Scope safety: API data flow, same-origin proxy work, middleware, backend services, package manifests, and user-owned performance/security changes remain outside the redesign.

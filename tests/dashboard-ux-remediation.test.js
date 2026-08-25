import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('dashboard mutations return to the console with explicit success and error state', async () => {
	const [route, security, shell, flash] = await Promise.all([
		read('../apps/dashboard/app/api/control/[...path]/route.ts'),
		read('../apps/dashboard/lib/request-security.js'),
		read('../apps/dashboard/components/console-ui.tsx'),
		read('../apps/dashboard/components/flash-banner.tsx'),
	]);
	assert.match(route, /isFormSubmission/);
	assert.match(route, /withFlashMessage/);
	assert.match(route, /formErrorRedirect/);
	assert.match(route, /upstream\.ok/);
	assert.match(security, /request_failed/);
	assert.match(security, /searchParams\.delete/);
	assert.match(shell, /<Suspense fallback=\{null\}><FlashBanner \/><\/Suspense>/);
	assert.match(flash, /useSearchParams/);
	assert.match(flash, /role="alert"/);
	assert.match(flash, /role="status"/);
	assert.doesNotMatch(flash, />\{(?:code|noticeCode)\}</);
});

test('API loader failures stay sanitized, preserve fallback data and surface on authenticated data pages', async () => {
	const [api, shell, ...pages] = await Promise.all([
		read('../apps/dashboard/lib/api.ts'),
		read('../apps/dashboard/components/console-ui.tsx'),
		read('../apps/dashboard/app/admin/page.tsx'),
		read('../apps/dashboard/app/github/page.tsx'),
		read('../apps/dashboard/app/org/[orgSlug]/projects/page.tsx'),
		read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
		read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
		read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx'),
	]);
	assert.match(api, /collectLoadIssues/);
	assert.match(api, /publicFailureMessage/);
	assert.match(api, /body: fallback/);
	assert.doesNotMatch(api, /error:\s*payload\?\.error/);
	assert.match(shell, /export function LoadErrorSummary/);
	for (const page of pages) assert.match(page, /<LoadErrorSummary issues=/);
});

test('dangerous actions require an explicit target-specific confirmation', async () => {
	const [admin, deployment] = await Promise.all([
		read('../apps/dashboard/app/admin/page.tsx'),
		read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx'),
	]);
	assert.doesNotMatch(admin, /state\.users\[0\]/);
	assert.match(admin, /user\.id[\s\S]*name="confirmed"[\s\S]*required/);
	assert.match(deployment, /id="rollback-deployment"[\s\S]*name="confirmed"[\s\S]*required/);
});

test('project creation displays the route organization but does not submit tenant identity', async () => {
	const [createProject, wizard, route] = await Promise.all([
		read('../apps/dashboard/app/org/[orgSlug]/projects/new/page.tsx'),
		read('../apps/dashboard/components/project-create-wizard.tsx'),
		read('../apps/dashboard/app/api/control/[...path]/route.ts'),
	]);
	assert.match(wizard, /value=\{orgSlug\}\s+readOnly/);
	assert.match(wizard, /로그인 권한으로 확인/);
	assert.match(wizard, /name="serviceName"/);
	assert.doesNotMatch(`${createProject}\n${wizard}`, /name="organizationId"/);
	assert.match(route, /projectCreatePayloadFromForm/);
});

test('project cards render API aggregate service and resource counts', async () => {
	const projectCard = await read('../apps/dashboard/components/project-card.tsx');
	assert.match(projectCard, /serviceCount/);
	assert.match(projectCard, /resourceCount/);
	assert.match(projectCard, /project\.services\s*\?\?\s*project\.serviceCount/);
	assert.match(projectCard, /project\.resources\s*\?\?\s*project\.resourceCount/);
});

test('authenticated users can clear their dashboard session through the same-origin BFF', async () => {
	const shell = await read('../apps/dashboard/components/console-ui.tsx');
	assert.match(shell, /method="post"\s+action=\{apiAction\('\/auth\/logout'\)\}/);
	assert.match(shell, /name="_returnTo"\s+value="\/login"/);
	assert.match(shell, />로그아웃<\/button>/);
});

test('dashboard request hardening uses the supported Next proxy convention', async () => {
	const [proxy, layout] = await Promise.all([
		read('../apps/dashboard/proxy.ts'),
		read('../apps/dashboard/app/layout.tsx'),
	]);
	assert.match(proxy, /export function proxy\(request: NextRequest\)/);
	for (const marker of ['dashboardSecurityHeaders', 'content-security-policy', 'x-nonce']) assert.match(proxy, new RegExp(marker));
	assert.match(proxy, /request\.cookies\.get\(SESSION_COOKIE_NAME\)/);
	assert.doesNotMatch(proxy, /RAIBITSERVER_DASHBOARD_TOKEN|hasServerApiToken/);
	assert.match(layout, /export const dynamic = 'force-dynamic'/, 'nonce CSP requires request-time rendering');
});

test('dashboard BFF bounds request and response bodies while preserving SSE pass-through', async () => {
	const [route, security] = await Promise.all([
		read('../apps/dashboard/app/api/control/[...path]/route.ts'),
		read('../apps/dashboard/lib/request-security.js'),
	]);
	for (const marker of ['dashboardRequestUrl', 'fetchWithInitialResponseTimeout', 'readBoundedBody', 'boundedPassThrough', 'browserSafePayload']) {
		assert.match(route, new RegExp(marker));
	}
	assert.doesNotMatch(route, /upstream\.text\(\)/);
	assert.doesNotMatch(route, /request\.arrayBuffer\(\)/);
	assert.match(route, /text\/event-stream/);
	assert.match(security, /response_too_large/);
});

test('dashboard server loaders bound control-plane connection time and response bytes', async () => {
	const api = await read('../apps/dashboard/lib/api.ts');
	assert.match(api, /fetchWithInitialResponseTimeout/);
	assert.match(api, /readBoundedBody/);
	assert.match(api, /declaredLength:\s*response\.headers\.get\('content-length'\)/);
	assert.match(api, /control_plane_response_too_large/);
	assert.match(api, /control_plane_response_timeout/);
	assert.doesNotMatch(api, /response\.text\(\)/);
});

test('dashboard has route-level loading, error, not-found, accessible controls and functional project navigation', async () => {
	const [loading, error, notFound, project, css] = await Promise.all([
		read('../apps/dashboard/app/loading.tsx'),
		read('../apps/dashboard/app/error.tsx'),
		read('../apps/dashboard/app/not-found.tsx'),
		read('../apps/dashboard/app/org/[orgSlug]/projects/[projectId]/page.tsx'),
		read('../apps/dashboard/app/globals.css'),
	]);
	assert.match(loading, /aria-live="polite"/);
	assert.match(error, /role="alert"/);
	assert.match(notFound, /찾을 수 없습니다/);
	for (const target of ['overview', 'services', 'deployments', 'resources']) assert.match(project, new RegExp(`\\?view=${target}`));
	assert.match(project, /<SectionNav items=\{navItems\} current=\{view\}/);
	assert.doesNotMatch(project, /href=\{apiAction\(`\/services\/\$\{state\.services\[0\]\.id\}\/logs`\)\}/);
	assert.match(css, /min-height:\s*44px/);
	assert.match(css, /-webkit-overflow-scrolling:\s*touch/);
	assert.match(css, /\.confirmation-control/);
	assert.match(css, /\.quota-editor > summary/);
});

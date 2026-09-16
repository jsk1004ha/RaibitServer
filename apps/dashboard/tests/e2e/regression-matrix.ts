export const ROLES = ['anonymous', 'user', 'admin'] as const;
export type MatrixActor = (typeof ROLES)[number];

export const FIXTURE_STATES = ['populated', 'empty', 'partial', 'long', 'hostile', 'expired'] as const;
export type MatrixState = (typeof FIXTURE_STATES)[number];

export const TEMPLATE_VIEWPORTS = [{ width: 375, height: 812 }, { width: 1280, height: 800 }] as const;
export const SHELL_VIEWPORTS = [{ width: 767, height: 1024 }, { width: 768, height: 1024 }] as const;
export const ROUTE_BATCH_SIZE = 12;
export const HOSTED_ERROR_CASES = [404, 422, 503, 507, 599] as const;
export const MATRIX_TIMEOUTS = { routeBaseMs: 6000, routeStepMs: 1800, templateMs: 15000, hostedErrorMs: 15000 } as const;

export const ERROR_STATUS_CODES = [
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413,
  414, 415, 416, 417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 511,
] as const;
export const GUIDE_TOPICS = ['projects', 'source', 'environment', 'deployments', 'resources', 'github', 'administration'] as const;
export const PROJECT_VIEWS = ['overview', 'services', 'new-service', 'edit-service', 'deployments', 'agent', 'resources', 'new-resource', 'environment', 'logs', 'settings'] as const;
export const DEPLOYMENT_VIEWS = ['overview', 'logs', 'events', 'rollback', 'cancel'] as const;
export const RESOURCE_VIEWS = ['overview', 'schema', 'query', 'provider', 'backups', 'provision', 'connection'] as const;
export const GITHUB_STEPS = ['connect', 'import', 'attach', 'sync'] as const;

export type RouteScenario = Readonly<{
  id: string;
  family: string;
  origin: 'public' | 'console';
  path: string;
  actor: MatrixActor;
  state: MatrixState;
  expected: 'document' | 'login-redirect' | 'console-redirect';
  allowedStatuses?: readonly number[];
}>;

const publicRoutes = ['/', '/status', '/support', '/privacy', '/contributors'] as const;
const projectBase = '/org/raibit/projects/prj_fixture_001';
const deploymentBase = `${projectBase}/deployments/dep_fixture_ready`;
const resourceBase = `${projectBase}/resources/res_fixture_pg/console`;

const documents: readonly RouteScenario[] = [
  ...publicRoutes.map((path) => ({ id: `public-${path === '/' ? 'home' : path.slice(1)}`, family: 'public', origin: 'public', path, actor: 'anonymous', state: 'populated', expected: 'document' } as const)),
  ...['/login', '/login?mode=signup', '/login?mode=verify&email=verify%40fixture.test', '/login?error=invalid_credentials', '/login?notice=saved'].map((path, index) => ({ id: `auth-${index}`, family: 'auth', origin: 'console', path, actor: 'anonymous', state: 'populated', expected: 'document' } as const)),
  { id: 'error-catalog', family: 'errors', origin: 'public', path: '/errors', actor: 'anonymous', state: 'populated', expected: 'document' },
  ...ERROR_STATUS_CODES.map((code) => ({ id: `error-${code}`, family: 'errors', origin: 'public', path: `/errors/${code}`, actor: 'anonymous', state: 'populated', expected: 'document' } as const)),
  { id: 'error-fallback', family: 'errors', origin: 'public', path: '/errors/not-supported', actor: 'anonymous', state: 'populated', expected: 'document' },
  { id: 'console', family: 'console', origin: 'console', path: '/console', actor: 'user', state: 'populated', expected: 'document' },
  { id: 'projects-list', family: 'projects', origin: 'console', path: '/org/raibit/projects', actor: 'user', state: 'populated', expected: 'document' },
  { id: 'projects-new', family: 'projects', origin: 'console', path: '/org/raibit/projects/new', actor: 'user', state: 'populated', expected: 'document' },
  ...GUIDE_TOPICS.map((topic) => ({ id: `guide-${topic}`, family: 'guide', origin: 'console', path: `/guide?topic=${topic}`, actor: 'user', state: 'populated', expected: 'document' } as const)),
  ...PROJECT_VIEWS.map((view) => ({ id: `project-${view}`, family: 'project', origin: 'console', path: `${projectBase}?view=${view}${['edit-service', 'environment', 'logs'].includes(view) ? '&serviceId=svc_fixture_web' : ''}`, actor: 'user', state: 'populated', expected: 'document' } as const)),
  ...DEPLOYMENT_VIEWS.map((view) => ({ id: `deployment-${view}`, family: 'deployment', origin: 'console', path: `${deploymentBase}?view=${view}`, actor: 'user', state: 'populated', expected: 'document' } as const)),
  ...RESOURCE_VIEWS.map((view) => ({ id: `resource-${view}`, family: 'resource', origin: 'console', path: `${resourceBase}?view=${view}`, actor: 'user', state: 'populated', expected: 'document' } as const)),
  ...GITHUB_STEPS.map((step) => ({ id: `github-${step}`, family: 'github', origin: 'console', path: `/github?step=${step}`, actor: 'user', state: 'populated', expected: 'document' } as const)),
  { id: 'admin', family: 'admin', origin: 'console', path: '/admin', actor: 'admin', state: 'populated', expected: 'document' },
];

const stateSamples: readonly RouteScenario[] = [
  ...(['empty', 'partial', 'long'] as const).map((state) => ({ id: `${state}-public`, family: 'public', origin: 'public', path: '/', actor: 'anonymous', state, expected: 'document', allowedStatuses: state === 'partial' ? [503] : [] } as const)),
  ...(['empty', 'partial', 'long'] as const).flatMap((state) => [
    { id: `${state}-console`, family: 'console', origin: 'console', path: '/console', actor: 'user', state, expected: 'document', allowedStatuses: state === 'partial' ? [500] : [] },
    { id: `${state}-projects`, family: 'projects', origin: 'console', path: '/org/raibit/projects', actor: 'user', state, expected: 'document' },
    { id: `${state}-project`, family: 'project', origin: 'console', path: `${projectBase}?view=overview`, actor: 'user', state, expected: 'document' },
    { id: `${state}-deployment`, family: 'deployment', origin: 'console', path: `${deploymentBase}?view=${state === 'partial' ? 'events' : 'logs'}`, actor: 'user', state, expected: 'document', allowedStatuses: state === 'partial' ? [503] : [] },
    { id: `${state}-resource`, family: 'resource', origin: 'console', path: `${resourceBase}?view=schema`, actor: 'user', state, expected: 'document', allowedStatuses: state === 'partial' ? [503] : [] },
    { id: `${state}-github`, family: 'github', origin: 'console', path: '/github?step=import', actor: 'user', state, expected: 'document', allowedStatuses: state === 'partial' ? [500] : [] },
    { id: `${state}-admin`, family: 'admin', origin: 'console', path: '/admin', actor: 'admin', state, expected: 'document', allowedStatuses: state === 'partial' ? [500] : [] },
  ] satisfies readonly RouteScenario[]),
  { id: 'hostile-deployment', family: 'deployment', origin: 'console', path: `${projectBase}/deployments/${encodeURIComponent('dep_fixture_<img src=x onerror=fixture-hostile-id>')}?view=logs`, actor: 'user', state: 'hostile', expected: 'document' },
];

const expiredRoutes = [
  ['console', '/console'], ['projects', '/org/raibit/projects'], ['guide', '/guide?topic=projects'], ['project', `${projectBase}?view=overview`],
  ['deployment', `${deploymentBase}?view=overview`], ['resource', `${resourceBase}?view=overview`], ['github', '/github?step=connect'], ['admin', '/admin'],
] as const;
const expired: readonly RouteScenario[] = expiredRoutes.map(([family, path]) => ({ id: `expired-${family}`, family, origin: 'console', path, actor: 'user', state: 'expired', expected: 'login-redirect' }));
const anonymousProtected: readonly RouteScenario[] = expiredRoutes.map(([family, path]) => ({ id: `anonymous-${family}`, family, origin: 'console', path, actor: 'anonymous', state: 'populated', expected: 'login-redirect' }));

export const ROUTE_MATRIX: readonly RouteScenario[] = [
  ...documents,
  ...stateSamples,
  ...expired,
  ...anonymousProtected,
  { id: 'anonymous-console-error-preview', family: 'errors', origin: 'console', path: '/errors/503', actor: 'anonymous', state: 'populated', expected: 'login-redirect' },
  { id: 'user-admin-denied', family: 'admin', origin: 'console', path: '/admin', actor: 'user', state: 'populated', expected: 'console-redirect' },
];

export type RouteBatch = Readonly<{ id: string; scenarios: readonly RouteScenario[] }>;
const routeCohorts = new Map<string, RouteScenario[]>();
for (const scenario of ROUTE_MATRIX) {
  const cohort = `${scenario.actor}-${scenario.state}-${scenario.origin}`;
  const scenarios = routeCohorts.get(cohort) ?? [];
  scenarios.push(scenario);
  routeCohorts.set(cohort, scenarios);
}
export const ROUTE_BATCHES: readonly RouteBatch[] = [...routeCohorts].flatMap(([cohort, scenarios]) => {
  const count = Math.ceil(scenarios.length / ROUTE_BATCH_SIZE);
  return Array.from({ length: count }, (_, index) => ({
    id: count === 1 ? cohort : `${cohort}-${index + 1}-of-${count}`,
    scenarios: scenarios.slice(index * ROUTE_BATCH_SIZE, (index + 1) * ROUTE_BATCH_SIZE),
  }));
});

export const TEMPLATE_MATRIX = [
  ['public', 'public', '/', 'anonymous', 'populated'], ['auth', 'console', '/login?mode=signup', 'anonymous', 'populated'],
  ['console', 'console', '/console', 'user', 'long'], ['projects', 'console', '/org/raibit/projects', 'user', 'empty'],
  ['wizard', 'console', '/org/raibit/projects/new', 'user', 'populated'], ['project', 'console', `${projectBase}?view=services`, 'user', 'populated'],
  ['deployment', 'console', `${deploymentBase}?view=logs`, 'user', 'long'], ['resource', 'console', `${resourceBase}?view=schema`, 'user', 'partial'],
  ['github', 'console', '/github?step=import', 'user', 'empty'], ['admin', 'console', '/admin', 'admin', 'long'],
  ['error', 'public', '/errors/503', 'anonymous', 'populated'],
] as const;

export const COVERAGE_EVIDENCE = [
  { id: 'auth-mutations', risk: 'happy-mutation', spec: 'apps/dashboard/tests/e2e/specs/auth-flows.spec.ts', marker: 'server-rendered login, signup, and verification forms preserve navigation and FormData' },
  { id: 'auth-resend', risk: 'happy-mutation', spec: 'apps/dashboard/tests/e2e/specs/auth-flows.spec.ts', marker: 'resend executes independently after keyboard submission and records its FormData' },
  { id: 'wizard-mutation', risk: 'happy-mutation', spec: 'apps/dashboard/tests/e2e/specs/projects-guide.spec.ts', marker: 'four-step project wizard guards progression, focus and exact native FormData' },
  { id: 'project-mutations', risk: 'happy-mutation', spec: 'apps/dashboard/tests/e2e/specs/t12-project-hub.spec.ts', marker: 'native service, resource, environment, agent, and deletion controls preserve payload safety' },
  { id: 'operation-mutations', risk: 'happy-mutation', spec: 'apps/dashboard/tests/e2e/specs/task-13-operations.spec.ts', marker: 'resource query, provider, provision, and attach forms preserve exact native payloads' },
  { id: 'github-mutations', risk: 'happy-mutation', spec: 'apps/dashboard/tests/e2e/specs/t14-github-admin.spec.ts', marker: 'GitHub seeded and empty workflows keep deterministic step routes and native mutation data' },
  { id: 'admin-mutations', risk: 'happy-mutation', spec: 'apps/dashboard/tests/e2e/specs/t14-github-admin.spec.ts', marker: 'admin workflows preserve exact approval, rejection, ban, and authorization behavior' },
  { id: 'project-destructive', risk: 'destructive-failure', spec: 'apps/dashboard/tests/e2e/specs/t12-project-hub.spec.ts', marker: 'native service, resource, environment, agent, and deletion controls preserve payload safety' },
  { id: 'deployment-destructive', risk: 'destructive-failure', spec: 'apps/dashboard/tests/e2e/specs/task-13-operations.spec.ts', marker: 'deployment detail shows only the server-provided recovery action without a manual image rollback input' },
  { id: 'provider-destructive', risk: 'destructive-failure', spec: 'apps/dashboard/tests/e2e/specs/task-13-operations.spec.ts', marker: 'resource query, provider, provision, and attach forms preserve exact native payloads' },
  { id: 'admin-destructive', risk: 'destructive-failure', spec: 'apps/dashboard/tests/e2e/specs/t14-github-admin.spec.ts', marker: 'admin workflows preserve exact approval, rejection, ban, and authorization behavior' },
  { id: 'focus', risk: 'keyboard-focus', spec: 'apps/dashboard/tests/e2e/specs/projects-guide.spec.ts', marker: 'guards progression, focus and exact native FormData' },
  { id: 'targets', risk: 'touch-target', spec: 'apps/dashboard/tests/e2e/specs/t16-full-regression-matrix.spec.ts', marker: 'primary mobile targets remain at least 44px' },
  { id: 'motion', risk: 'reduced-motion', spec: 'apps/dashboard/tests/e2e/specs/t16-full-regression-matrix.spec.ts', marker: 'reduced motion and shell breakpoint ownership remain deterministic' },
  { id: 'axe', risk: 'axe', spec: 'apps/dashboard/tests/e2e/specs/t16-full-regression-matrix.spec.ts', marker: 'one-width behavioral matrix' },
  { id: 'browser', risk: 'console-network-csp-hydration', spec: 'apps/dashboard/tests/e2e/specs/t16-full-regression-matrix.spec.ts', marker: 'console, network, CSP, and hydration logs remain clean' },
  { id: 'headers', risk: 'hosted-error-headers', spec: 'apps/dashboard/tests/e2e/specs/t16-full-regression-matrix.spec.ts', marker: 'standalone hosted error' },
  { id: 'secrets', risk: 'secrets', spec: 'apps/dashboard/tests/e2e/specs/task-13-operations.spec.ts', marker: 'hostile deployment data remains literal, complete, and bounded' },
  { id: 'overflow', risk: 'overflow-scroll', spec: 'apps/dashboard/tests/e2e/specs/t15-preflight-cutover.spec.ts', marker: 'long text keep intentional base behavior' },
] as const;

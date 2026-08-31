import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  isFinalProjectWizardStep,
  nextProjectWizardStep,
  projectWizardSteps,
} from '../components/project-create-wizard-state.ts';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('T11 project pages preserve organization-aware routes and aggregate counts', async () => {
  const [overview, projects, card] = await Promise.all([
    read('app/console/page.tsx'),
    read('app/org/[orgSlug]/projects/page.tsx'),
    read('components/project-card.tsx'),
  ]);
  assert.match(overview, /redirect\('\/login\?error=session_expired&next=\/console'\)/);
  assert.match(overview, /project\.organizationSlug \|\| project\.organizationId/);
  assert.match(overview, /project\.serviceCount \?\? project\.services/);
  assert.match(overview, /project\.resourceCount \?\? project\.resources/);
  assert.match(overview, /일부 정보를 불러오지 못했습니다\./);
  assert.doesNotMatch(overview, /issue\.message/);
  assert.match(projects, /orgSlug === 'all'/);
  assert.match(projects, /href=\{`\/org\/\$\{orgSlug\}\/projects\/\$\{project\.id\}`\}/);
  assert.match(card, /project\.services \?\? project\.serviceCount \?\? 0/);
  assert.match(card, /project\.resources \?\? project\.resourceCount \?\? 0/);
});

test('T11 wizard keeps native payload and guarded accessible steps', async () => {
  const wizard = await read('components/project-create-wizard.tsx');
  assert.match(wizard, /<form ref=\{formRef\} method="post" action=\{action\} onSubmit=\{guardSubmit\}/);
  for (const name of ['name', 'slug', 'serviceName', 'repoUrl', 'branch', 'sourceType', 'image', 'dockerfilePath', 'buildContext', 'type', 'database', 'cache']) {
    assert.match(wizard, new RegExp(`name="${name}"`));
  }
  assert.doesNotMatch(wizard, /name="organizationId"/);
  assert.match(wizard, /value=\{orgSlug\} readOnly/);
  assert.match(wizard, /querySelector<HTMLElement>\(`\[data-step=/);
  assert.match(wizard, /querySelector<HTMLInputElement \| HTMLSelectElement>\(':invalid'\)/);
  assert.match(wizard, /hidden=\{step !== [0-3]\}/);
  assert.match(wizard, /useLayoutEffect\(\(\) => \{ headingRef\.current\?\.focus\(\{ preventScroll: true \}\); \}, \[stepId\]\)/);
  assert.match(wizard, /tabIndex=\{-1\}/);
  assert.match(wizard, /data-project-create-form/);
  assert.match(wizard, /<button type="button" className=\{buttonVariants\(\)\} onClick=\{handleNextClick\} data-wizard-next>/);
  assert.match(wizard, /<button type="submit" className=\{buttonVariants\(\)\} data-wizard-submit>프로젝트 만들기<\/button>/);
  assert.match(wizard, /current \? 'text-primary' : 'text-muted-foreground'/);
  assert.match(wizard, /event\.preventDefault\(\);[\s\S]*moveNext\(\);/);
  assert.match(wizard, /if \(stepId === 'service'\) \{ setStepId\('resources'\); return; \}/);
  assert.doesNotMatch(wizard, /requestSubmit|\.submit\(/);
  assert.match(wizard, /Dockerfile이 있으면 프레임워크 자동 인식보다 먼저 사용/);
});

test('T11 wizard state machine visits resources before exposing final submit', () => {
  assert.deepEqual(projectWizardSteps.map((step) => step.id), ['project', 'source', 'service', 'resources']);
  const visited = ['project'];
  while (!isFinalProjectWizardStep(visited.at(-1))) {
    visited.push(nextProjectWizardStep(visited.at(-1)));
  }
  assert.deepEqual(visited, ['project', 'source', 'service', 'resources']);
  assert.equal(nextProjectWizardStep('service'), 'resources');
  assert.equal(isFinalProjectWizardStep('service'), false);
  assert.equal(isFinalProjectWizardStep('resources'), true);
});

test('T11 guide uses URL topics and resolves project destinations through the active organization', async () => {
  const guide = await read('app/guide/page.tsx');
  for (const topic of ['projects', 'source', 'environment', 'deployments', 'resources', 'github', 'administration']) {
    assert.match(guide, new RegExp(`/guide\\?topic=${topic}`));
  }
  assert.match(guide, /dashboardApiContext\(\)/);
  assert.match(guide, /getJson\('\/auth\/me'/);
  assert.match(guide, /getJson\('\/projects'/);
  assert.match(guide, /if \(!context\.token\) redirect\('\/login\?error=session_expired&next=\/guide'\)/);
  assert.match(guide, /redirect\('\/login\?error=session_expired&next=\/guide'\)/);
  assert.match(guide, /`\/org\/\$\{encodeURIComponent\(orgSlug\)\}\/projects`/);
  assert.match(guide, /<span className=\{cn\('text-xs', current \? 'text-primary' : 'text-muted-foreground'\)\}>\{item\.description\}<\/span>/);
  assert.doesNotMatch(guide, /href: '\/projects'/);
});

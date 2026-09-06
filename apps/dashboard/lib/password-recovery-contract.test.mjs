import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboard = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, dashboard), 'utf8');

test('password recovery keeps request and completion secrets out of navigation state', async () => {
  const [login, recovery, controlRoute] = await Promise.all([
    read('app/login/page.tsx'),
    read('components/password-recovery-form.tsx'),
    read('app/api/control/[...path]/route.ts'),
  ]);

  assert.match(login, /'forgot', 'reset'/);
  assert.match(login, /<PasswordRecoveryForm mode=\{mode\}/);
  assert.doesNotMatch(login, /<PasswordRecoveryForm[^>]*email=/);
  assert.match(recovery, /action=\{requestAction\}/);
  assert.match(recovery, /action=\{completeAction\}/);
  assert.match(recovery, /name="code"/);
  assert.match(recovery, /autoComplete="one-time-code"/);
  assert.match(recovery, /name="newPassword"/);
  assert.match(recovery, /name="confirmPassword"/);
  assert.match(recovery, /autoComplete="new-password"/);
  assert.match(recovery, /response\.headers\.get\('retry-after'\)/);
  assert.doesNotMatch(recovery, /localStorage|sessionStorage|window\.location|history\./);
  assert.match(controlRoute, /'\/auth\/password-reset\/request'/);
  assert.match(controlRoute, /'\/auth\/password-reset\/complete'/);
  assert.match(controlRoute, /copyRetryAfterHeader/);
});

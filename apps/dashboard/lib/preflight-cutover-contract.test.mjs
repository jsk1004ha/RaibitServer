import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardRoot = new URL("../", import.meta.url);
const css = await readFile(new URL("app/globals.css", dashboardRoot), "utf8");
const shell = await readFile(new URL("components/console-ui.tsx", dashboardRoot), "utf8");
const login = await readFile(new URL("app/login/page.tsx", dashboardRoot), "utf8");
const operations = await readFile(
  new URL("app/org/[orgSlug]/projects/[projectId]/deployments/[deploymentId]/page.tsx", dashboardRoot),
  "utf8",
);
const resources = await readFile(
  new URL("app/org/[orgSlug]/projects/[projectId]/resources/[resourceId]/console/page.tsx", dashboardRoot),
  "utf8",
);

test("Given Tailwind v4, when global CSS loads, then Preflight is imported exactly once in layer order", () => {
  const imports = [...css.matchAll(/^@import\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(imports.slice(0, 3), [
    "tailwindcss/theme.css",
    "tailwindcss/preflight.css",
    "tailwindcss/utilities.css",
  ]);
  assert.equal(imports.filter((value) => value === "tailwindcss/preflight.css").length, 1);
  assert.equal(imports.includes("tailwindcss"), false);
});

test("Given the RAIBIT theme contract, when legacy CSS is retired, then green aliases remain absent", () => {
  for (const forbidden of [`#${"68"}df88`, [104, 223, 136].join(" "), "raibit-legacy"]) {
    assert.equal(css.toLowerCase().includes(forbidden), false, `${forbidden} must not remain`);
  }
  for (const selector of [".app-shell", ".sidebar", ".topbar", ".landing-page", ".btn", ".quota-editor"]) {
    assert.equal(css.includes(selector), false, `${selector} must not remain`);
  }
  for (const deadKeyframe of ["status-refresh-spin", "contributor-crown-float", "contributor-sparkle"]) {
    assert.equal(css.includes(deadKeyframe), false, `${deadKeyframe} must not remain without a consumer`);
  }
  assert.match(css, /--background:\s*#ffffff;/);
  assert.match(css, /--primary:\s*#091936;/);
  assert.match(css, /--canvas-night:\s*#1c1c1c;/);
  assert.match(css, /--destructive:\s*color-mix\(in srgb, var\(--integration-crimson\) 78%, var\(--foreground\)\);/);
  assert.match(css, /\[data-theme="dark"\][\s\S]*--background:\s*var\(--raibit-dark-canvas\);/);
  assert.match(css, /prefers-color-scheme:\s*dark[\s\S]*\[data-theme="system"\]/);
});

test("Given surviving non-Tailwind consumers, when classes are composed dynamically, then the temporary allowlist documents every recipe", () => {
  const allowlist = css.match(/t15-legacy-class-allowlist:\s*([\s\S]*?)\*\//)?.[1] ?? "";
  for (const token of [
    "section-nav-{tabs,steps}",
    "status-tone-{ok,info,warn,danger}",
    "metric-tone-{ok,info,warn,danger}",
    "auth-form",
    "auth-message",
    "auth-resend",
    "confirmation-control",
    "load-error-summary",
  ]) assert.ok(allowlist.includes(token), `${token} missing from the temporary allowlist`);

  assert.match(shell, /section-nav-\$\{variant\}/);
  assert.match(shell, /statusTone\(text\)/);
  assert.match(shell, /item\.tone \|\| 'ok'/);
  assert.match(login, /className="auth-form"/);
  assert.match(login, /className="auth-message/);
  assert.match(login, /className="auth-resend"/);
  assert.match(operations, /className="confirmation-control"/);
  assert.match(resources, /className="confirmation-control"/);

  const selectors = [...new Set([...css.matchAll(/(?<![\w-])\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]))].sort();
  assert.deepEqual(selectors, [
    "auth-form", "auth-message", "auth-resend", "badge", "card-title", "code-panel",
    "confirmation-control", "console-data-block", "danger", "icon", "info", "load-error-summary",
    "log-line", "log-viewer", "metric-detail", "metric-item", "metric-label", "metric-meter",
    "metric-strip", "metric-value", "muted", "ok", "section-nav", "section-nav-index",
    "section-nav-item", "section-nav-steps", "warn",
  ]);
});

test("Given Preflight-sensitive surfaces, when global CSS reconciles browser defaults, then accessibility media rules remain explicit", () => {
  assert.match(css, /button:not\(:disabled\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s+print/);
  assert.match(css, /@media\s+\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /\.confirmation-control input\[type="checkbox"\]/);
  assert.match(css, /\.code-panel/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardRoot = new URL("../", import.meta.url);
const css = await readFile(new URL("app/globals.css", dashboardRoot), "utf8");

const lockedPalette = {
  "--raibit-dark-canvas": "#11161d",
  "--raibit-dark-surface-1": "#181f29",
  "--raibit-dark-surface-2": "#202a36",
  "--raibit-dark-surface-3": "#2a3645",
  "--raibit-dark-night": "#090c11",
  "--raibit-dark-night-raised": "#151b24",
  "--raibit-dark-brand-surface": "#0b1d3a",
  "--raibit-dark-brand-foreground": "#f5f8ff",
  "--raibit-dark-foreground": "#f4f6f8",
  "--raibit-dark-foreground-secondary": "#d3dae3",
  "--raibit-dark-muted-foreground": "#a9b4c3",
  "--raibit-dark-muted-2": "#8a95a4",
  "--raibit-dark-faint": "#758190",
  "--raibit-dark-border": "#344459",
  "--raibit-dark-control-border": "#708197",
  "--raibit-dark-primary": "#7fa4dd",
  "--raibit-dark-primary-foreground": "#071229",
  "--raibit-dark-primary-pressed": "#6d90c8",
  "--raibit-dark-primary-soft": "#1d3150",
  "--raibit-dark-accent-foreground": "#dce9ff",
  "--raibit-dark-destructive": "#ff7098",
  "--raibit-dark-destructive-foreground": "#260914",
  "--raibit-dark-selection": "rgb(127 164 221 / 32%)",
  "--raibit-dark-integration-purple": "#c084fc",
  "--raibit-dark-integration-violet": "#a78bfa",
  "--raibit-dark-integration-purple-soft": "#312044",
  "--raibit-dark-integration-yellow": "#facc15",
  "--raibit-dark-integration-tomato": "#ff7a66",
  "--raibit-dark-integration-pink": "#f472b6",
  "--raibit-dark-integration-indigo": "#7aa2ff",
  "--raibit-dark-integration-crimson": "#fb7185",
};

const lightValues = {
  "--canvas": "#ffffff",
  "--canvas-soft": "#fafafa",
  "--canvas-night": "#1c1c1c",
  "--canvas-night-soft": "#202020",
  "--ink": "#171717",
  "--ink-secondary": "#212121",
  "--ink-mute": "#707070",
  "--ink-mute-2": "#9a9a9a",
  "--ink-faint": "#b2b2b2",
  "--hairline": "#dfdfdf",
  "--hairline-strong": "#c7c7c7",
  "--hairline-cool": "#ededed",
  "--hairline-cool-2": "#efefef",
  "--hairline-cool-3": "#d4d4d4",
  "--integration-purple": "#6b01c2",
  "--integration-violet": "#644fc1",
  "--integration-purple-soft": "#eddbf9",
  "--integration-yellow": "#ffdb13",
  "--integration-tomato": "#ff2201",
  "--integration-pink": "#c7007e",
  "--integration-indigo": "#054cff",
  "--integration-crimson": "#e2005a",
  "--background": "#ffffff",
  "--foreground": "#171717",
  "--card": "#ffffff",
  "--card-foreground": "#171717",
  "--popover": "#ffffff",
  "--popover-foreground": "#171717",
  "--primary": "#091936",
  "--primary-foreground": "#ffffff",
  "--primary-deep": "#071229",
  "--primary-soft": "#e9eef6",
  "--secondary": "#fafafa",
  "--secondary-foreground": "#212121",
  "--muted": "#fafafa",
  "--muted-foreground": "#707070",
  "--accent": "#e9eef6",
  "--accent-foreground": "#091936",
  "--destructive": "color-mix(in srgb, var(--integration-crimson) 78%, var(--foreground))",
  "--destructive-foreground": "#ffffff",
  "--border": "#dfdfdf",
  "--input": "#c7c7c7",
  "--ring": "#091936",
  "--inverse": "#1c1c1c",
  "--inverse-raised": "#202020",
  "--inverse-foreground": "#ffffff",
  "--selection": "rgb(9 25 54 / 28%)",
};

const lightBrandAliases = {
  "--brand-surface": "#091936",
  "--brand-surface-foreground": "#ffffff",
};

const darkAliases = {
  "--canvas": "var(--raibit-dark-canvas)",
  "--canvas-soft": "var(--raibit-dark-surface-1)",
  "--canvas-night": "var(--raibit-dark-night)",
  "--canvas-night-soft": "var(--raibit-dark-night-raised)",
  "--ink": "var(--raibit-dark-foreground)",
  "--ink-secondary": "var(--raibit-dark-foreground-secondary)",
  "--ink-mute": "var(--raibit-dark-muted-foreground)",
  "--ink-mute-2": "var(--raibit-dark-muted-2)",
  "--ink-faint": "var(--raibit-dark-faint)",
  "--hairline": "var(--raibit-dark-border)",
  "--hairline-strong": "var(--raibit-dark-control-border)",
  "--hairline-cool": "var(--raibit-dark-border)",
  "--hairline-cool-2": "var(--raibit-dark-border)",
  "--hairline-cool-3": "var(--raibit-dark-border)",
  "--integration-purple": "var(--raibit-dark-integration-purple)",
  "--integration-violet": "var(--raibit-dark-integration-violet)",
  "--integration-purple-soft": "var(--raibit-dark-integration-purple-soft)",
  "--integration-yellow": "var(--raibit-dark-integration-yellow)",
  "--integration-tomato": "var(--raibit-dark-integration-tomato)",
  "--integration-pink": "var(--raibit-dark-integration-pink)",
  "--integration-indigo": "var(--raibit-dark-integration-indigo)",
  "--integration-crimson": "var(--raibit-dark-integration-crimson)",
  "--background": "var(--raibit-dark-canvas)",
  "--foreground": "var(--raibit-dark-foreground)",
  "--card": "var(--raibit-dark-surface-2)",
  "--card-foreground": "var(--raibit-dark-foreground)",
  "--popover": "var(--raibit-dark-surface-3)",
  "--popover-foreground": "var(--raibit-dark-foreground)",
  "--primary": "var(--raibit-dark-primary)",
  "--primary-foreground": "var(--raibit-dark-primary-foreground)",
  "--primary-deep": "var(--raibit-dark-primary-pressed)",
  "--primary-soft": "var(--raibit-dark-primary-soft)",
  "--secondary": "var(--raibit-dark-surface-1)",
  "--secondary-foreground": "var(--raibit-dark-foreground-secondary)",
  "--muted": "var(--raibit-dark-surface-1)",
  "--muted-foreground": "var(--raibit-dark-muted-foreground)",
  "--accent": "var(--raibit-dark-primary-soft)",
  "--accent-foreground": "var(--raibit-dark-accent-foreground)",
  "--destructive": "var(--raibit-dark-destructive)",
  "--destructive-foreground": "var(--raibit-dark-destructive-foreground)",
  "--border": "var(--raibit-dark-border)",
  "--input": "var(--raibit-dark-control-border)",
  "--ring": "var(--raibit-dark-primary)",
  "--inverse": "var(--raibit-dark-night)",
  "--inverse-raised": "var(--raibit-dark-night-raised)",
  "--inverse-foreground": "var(--raibit-dark-foreground)",
  "--selection": "var(--raibit-dark-selection)",
  "--brand-surface": "var(--raibit-dark-brand-surface)",
  "--brand-surface-foreground": "var(--raibit-dark-brand-foreground)",
};

function declarations(block) {
  return Object.fromEntries([...block.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((match) => [match[1], match[2].trim()]));
}

function rootDeclarations(source) {
  const block = source.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1];
  assert.ok(block, "the root palette block must exist");
  return declarations(block);
}

function selectorDeclarations(source, selector) {
  const marker = `${selector} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${selector} must exist`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${selector} must close`);
  return declarations(source.slice(start + marker.length, end));
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g)?.map((channel) => Number.parseInt(channel, 16) / 255);
  assert.equal(channels?.length, 3, `expected a six-digit hex color, received ${hex}`);
  return channels.reduce((sum, channel, index) => sum + [0.2126, 0.7152, 0.0722][index] * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4), 0);
}

function contrast(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function assertDarkCssContract(source) {
  const root = rootDeclarations(source);
  for (const [name, value] of Object.entries(lockedPalette)) {
    assert.equal(root[name], value, `${name} must use its locked value`);
    assert.equal(
      Object.entries(root).filter(([token, candidate]) => token.startsWith("--raibit-dark-") && candidate.toLowerCase() === value.toLowerCase()).length,
      1,
      `${value} must have one raw dark declaration`,
    );
  }

  for (const [name, value] of Object.entries(lightValues)) assert.equal(root[name], value, `${name} must preserve its light value`);
  for (const [name, value] of Object.entries(lightBrandAliases)) assert.equal(root[name], value, `${name} must expose its light brand role`);

  const explicit = selectorDeclarations(source, '[data-theme="dark"]');
  const system = selectorDeclarations(source, '[data-theme="system"]');
  assert.deepEqual(explicit, system, "explicit and system dark selectors must map identically");
  assert.deepEqual(explicit, darkAliases, "dark semantic aliases must map only to the locked palette");
  assert.equal(source.includes("light-dark("), false, "light-dark() is not part of the theme contract");
  assert.equal(source.includes("[data-theme-toggle]"), false, "the retired fixed theme toggle CSS must be absent");
  assert.equal(source.includes("backdrop-filter"), false, "glass/backdrop CSS must be absent");

  assert.ok(contrast(lockedPalette["--raibit-dark-foreground"], lockedPalette["--raibit-dark-canvas"]) >= 4.5, "normal text must meet 4.5:1");
  assert.ok(contrast(lockedPalette["--raibit-dark-muted-2"], lockedPalette["--raibit-dark-surface-3"]) >= 3, "large text must meet 3:1");
  assert.ok(contrast(lockedPalette["--raibit-dark-primary-foreground"], lockedPalette["--raibit-dark-primary"]) >= 4.5, "primary content must meet 4.5:1");
  assert.ok(contrast(lockedPalette["--raibit-dark-brand-foreground"], lockedPalette["--raibit-dark-brand-surface"]) >= 4.5, "brand content must meet 4.5:1");
  assert.ok(contrast(lockedPalette["--raibit-dark-destructive-foreground"], lockedPalette["--raibit-dark-destructive"]) >= 4.5, "destructive content must meet 4.5:1");
  assert.ok(contrast(lockedPalette["--raibit-dark-control-border"], lockedPalette["--raibit-dark-surface-3"]) >= 3, "control border must meet 3:1 against surface-3");
}

test("the existing light scalar contract is pinned before dark mapping changes", () => {
  const root = rootDeclarations(css);
  for (const [name, value] of Object.entries(lightValues)) assert.equal(root[name], value, `${name} changed from its light contract`);
});

test("dark semantics use one locked raw palette and identical explicit/system alias maps", () => {
  assertDarkCssContract(css);
});

test("dark CSS contract rejects duplicate literals, selector drift, and the former weak control border", () => {
  assert.throws(
    () => assertDarkCssContract(css.replace("--raibit-dark-canvas: #11161d;", "--raibit-dark-canvas: #11161d;\n  --raibit-dark-canvas-copy: #11161d;")),
    /#11161d must have one raw dark declaration/,
  );

  const systemCard = css.lastIndexOf("--card: var(--raibit-dark-surface-2);");
  assert.notEqual(systemCard, -1, "system card mapping must be mutable for the negative case");
  assert.throws(
    () => assertDarkCssContract(`${css.slice(0, systemCard)}${css.slice(systemCard).replace("--card: var(--raibit-dark-surface-2);", "--card: var(--raibit-dark-surface-1);")}`),
    /explicit and system dark selectors must map identically/,
  );

  assert.throws(
    () => assertDarkCssContract(css.replace("--raibit-dark-control-border: #708197;", "--raibit-dark-control-border: #454b55;")),
    /--raibit-dark-control-border must use its locked value/,
  );
});

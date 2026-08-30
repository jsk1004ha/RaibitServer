import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const appDirectory = new URL("../", import.meta.url);
const css = await readFile(new URL("app/globals.css", appDirectory), "utf8");

test("global semantics use the RAIBIT light canvas and navy primary", () => {
  assert.match(css, /--background:\s*#ffffff;/);
  assert.match(css, /--primary:\s*#091936;/);
  assert.match(css, /@theme inline/);
  assert.equal(css.includes(`#${"68df88"}`), false);
  assert.equal(css.includes([104, 223, 136].join(" ")), false);
  assert.doesNotMatch(css, /color-scheme:\s*dark/);
});

test("root documents select the light contract", async () => {
  const [layout, globalError] = await Promise.all([
    readFile(new URL("app/layout.tsx", appDirectory), "utf8"),
    readFile(new URL("app/global-error.tsx", appDirectory), "utf8"),
  ]);

  assert.match(layout, /data-theme="light"/);
  assert.match(globalError, /data-theme="light"/);
});

test("the exact planned primitive modules exist without forbidden catalog filler", async () => {
  const files = (await readdir(new URL("components/ui/", appDirectory)))
    .filter((file) => file.endsWith(".tsx"))
    .sort();

  assert.deepEqual(files, [
    "alert.tsx",
    "badge.tsx",
    "breadcrumb.tsx",
    "button.tsx",
    "card.tsx",
    "checkbox.tsx",
    "command.tsx",
    "dialog.tsx",
    "dropdown-menu.tsx",
    "empty.tsx",
    "field.tsx",
    "input.tsx",
    "label.tsx",
    "progress.tsx",
    "select.tsx",
    "separator.tsx",
    "sheet.tsx",
    "skeleton.tsx",
    "spinner.tsx",
    "table.tsx",
    "textarea.tsx",
    "tooltip.tsx",
  ]);
  assert.equal(files.some((file) => /sidebar|tabs|toast|chart|form/.test(file)), false);
});

test("native form controls preserve browser names and values", async () => {
  const [input, textarea, select, checkbox] = await Promise.all([
    readFile(new URL("components/ui/input.tsx", appDirectory), "utf8"),
    readFile(new URL("components/ui/textarea.tsx", appDirectory), "utf8"),
    readFile(new URL("components/ui/select.tsx", appDirectory), "utf8"),
    readFile(new URL("components/ui/checkbox.tsx", appDirectory), "utf8"),
  ]);

  assert.match(input, /React\.ComponentProps<"input">/);
  assert.match(textarea, /React\.ComponentProps<"textarea">/);
  assert.match(select, /React\.ComponentProps<"select">/);
  assert.match(select, /<select[\s\S]*\{\.\.\.props\}/);
  assert.match(checkbox, /CheckboxPrimitive\.Root[\s\S]*\{\.\.\.props\}/);
});

test("interactive code is isolated to the planned client leaves", async () => {
  const files = (await readdir(new URL("components/ui/", appDirectory)))
    .filter((file) => file.endsWith(".tsx"));
  const clientFiles = [];

  for (const file of files) {
    const source = await readFile(new URL(`components/ui/${file}`, appDirectory), "utf8");
    if (source.startsWith('"use client"')) clientFiles.push(file);
  }

  assert.deepEqual(clientFiles.sort(), [
    "checkbox.tsx",
    "command.tsx",
    "dialog.tsx",
    "dropdown-menu.tsx",
    "progress.tsx",
    "sheet.tsx",
    "tooltip.tsx",
  ]);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dashboardRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contributorArrayHash = "dc4aaa7958372be428e4c0101841eed21d1285b837a94b4115323f8ea37f6177";
const keepWords = "break-keep [overflow-wrap:anywhere]";

async function read(relativePath) {
  return readFile(path.join(dashboardRoot, relativePath), "utf8");
}

function classWith(...tokens) {
  return new RegExp(`className=\"[^\"]*${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\"]*")}[^\"]*\"`);
}

test("Given narrow public routes When their short Korean header copy renders Then it keeps words together while retaining emergency overflow", async () => {
  const [status, support, contributors, privacy] = await Promise.all([
    read("app/status/page.tsx"),
    read("app/support/page.tsx"),
    read("app/contributors/page.tsx"),
    read("app/privacy/page.tsx"),
  ]);

  for (const source of [status, support, contributors]) {
    assert.match(source, classWith(keepWords, "text-display-xl"));
    assert.match(source, classWith(keepWords, "text-body-lg"));
  }

  const privacyHeader = privacy.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.match(privacyHeader, classWith(keepWords, "text-body-md", "text-pretty"));
});

test("Given public technical strings When short-copy wrapping is added Then URLs, email, and legal body containers retain their own overflow contracts", async () => {
  const [support, privacy] = await Promise.all([
    read("app/support/page.tsx"),
    read("app/privacy/page.tsx"),
  ]);

  assert.match(support, /const supportEmail = "ishsraibit@gmail\.com"/);
  assert.match(support, /href="https:\/\/github\.com\/jsk1004ha\/RaibitServer\/issues"/);
  assert.match(support, classWith("break-all", "text-heading-lg"));
  assert.doesNotMatch(support, classWith("break-all", "break-keep"));
  assert.match(privacy, /href="https:\/\/www\.privacy\.go\.kr"/);
  assert.match(privacy, classWith("break-words", "text-secondary-foreground"));
  assert.doesNotMatch(privacy, /<p className="mt-raibit-md max-w-4xl text-body-md text-pretty break-keep/);
});

test("Given the fresh origin contributor list When responsive classes change Then contributor content and ordering remain byte-identical", async () => {
  const source = await read("app/contributors/page.tsx");
  const contributorArray = source.match(/const contributors = \[[\s\S]*?\] as const;/)?.[0];

  assert.ok(contributorArray, "contributors data array must remain present");
  assert.equal(createHash("sha256").update(contributorArray.replaceAll("\r\n", "\n")).digest("hex"), contributorArrayHash);
});

import assert from "node:assert/strict";
import test from "node:test";
import { assetUrl, readRecorded, render } from "./worker-release.mjs";

const SOURCE = `import type { WorkerBundle } from "@moldesk/runtime";\n\nexport const RELEASED_WORKER_BUNDLE: WorkerBundle | undefined = undefined;\n\nexport function other() {}\n`;
const SHA = "a".repeat(64);

test("an unset constant reads as no bundle", () => {
  assert.equal(readRecorded(SOURCE), undefined);
});

test("render records a bundle that readRecorded finds again, leaving the rest of the file alone", () => {
  const bundle = { url: assetUrl("v1.2.3"), sha256: SHA };
  const next = render(SOURCE, bundle);
  assert.deepEqual(readRecorded(next), bundle);
  assert.match(next, /export function other\(\) \{\}/);
  assert.equal(render(next, undefined), SOURCE);
});

test("update is idempotent and replaces an earlier release", () => {
  const first = render(SOURCE, { url: assetUrl("v1.0.0"), sha256: SHA });
  const second = render(first, { url: assetUrl("v1.0.1"), sha256: "b".repeat(64) });
  assert.deepEqual(readRecorded(second), { url: assetUrl("v1.0.1"), sha256: "b".repeat(64) });
  assert.equal(second.match(/RELEASED_WORKER_BUNDLE/g).length, 1);
});

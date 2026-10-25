// The example's awk helper against real `moldesk compare --json` output (the actual code path, with captured
// US-align output instead of a live binary). Needs `pnpm build`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const awk = path.join(here, "deviation-window.awk");
const fixtures = path.join(root, "packages/visualizer/test/fixtures");
const captured = (name) => fs.readFileSync(path.join(root, "packages/core/src/analysis/testdata/usalign", name), "utf8");

const core = await import(path.join(root, "packages/core/dist/index.js"));

/** A MOLDESK_HOME holding a valid (placeholder) US-align installation, so `compare` reaches its runner. */
function fakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egfr-awk-"));
  const paths = core.getMoldeskPaths({ MOLDESK_HOME: dir });
  const installDir = path.join(paths.tools, "usalign", core.USALIGN_VERSION);
  fs.mkdirSync(path.join(installDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "bin", "USalign"), "placeholder");
  fs.writeFileSync(
    path.join(installDir, "installation.json"),
    JSON.stringify({ schemaVersion: 1, tool: "usalign", version: core.USALIGN_VERSION, binary: { path: "bin/USalign", sha256: createHash("sha256").update("placeholder").digest("hex") } }),
  );
  return paths;
}

const envelope = await core.compareStructureFiles(path.join(fixtures, "1CRN.pdb"), path.join(fixtures, "3HZ7.pdb"), {
  paths: fakeHome(),
  runner: async () => ({ code: 0, stdout: captured("crn-vs-3hz7.txt"), stderr: "" }),
});
const json = JSON.stringify(envelope, null, 2);
const pairs = envelope.result.mapping;

const run = (input, window) => spawnSync("awk", ["-v", `window=${window}`, "-f", awk], { input, encoding: "utf8" });

/** The same answer, computed directly from the structured result. */
function expected(window) {
  const w = window > 0 && window < pairs.length ? window : pairs.length;
  let best = -1;
  let at = 0;
  for (let i = 0; i + w <= pairs.length; i++) {
    const sum = pairs.slice(i, i + w).reduce((s, p) => s + p.distance, 0);
    if (sum > best) {
      best = sum;
      at = i;
    }
  }
  return `${pairs[at].b.authSeqId} ${pairs[at + w - 1].b.authSeqId} ${(best / w).toFixed(3)}`;
}

test("the fixture has real aligned pairs to work with", () => {
  assert.ok(pairs.length >= 20);
  assert.ok(Math.max(...pairs.map((p) => p.distance)) > 5);
});

test("finds the window with the largest mean deviation, as an independent calculation does", () => {
  for (const window of [1, 3, 5, 10, 27]) {
    const result = run(json, window);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected(window), `window ${window}`);
  }
});

test("a window of 1 is the single worst pair; a window as large as the alignment is the whole alignment", () => {
  const worst = pairs.reduce((a, b) => (b.distance > a.distance ? b : a));
  const [first, last, mean] = run(json, 1).stdout.trim().split(" ");
  assert.equal(Number(first), worst.b.authSeqId);
  assert.equal(Number(last), worst.b.authSeqId);
  assert.equal(Number(mean), Number(worst.distance.toFixed(3)));
  for (const window of [pairs.length, pairs.length + 50, 0]) {
    const [a, b] = run(json, window).stdout.trim().split(" ");
    assert.deepEqual([Number(a), Number(b)], [pairs[0].b.authSeqId, pairs.at(-1).b.authSeqId], `window ${window}`);
  }
});

test("ignores everything outside result.mapping (such as the warnings and the citation)", () => {
  const withNoise = JSON.stringify({ ...envelope, warnings: [{ code: "X", message: "has a \"distance\": 99 in it" }] }, null, 2);
  assert.equal(run(withNoise, 5).stdout.trim(), expected(5));
});

test("fails clearly when there are no aligned pairs", () => {
  const result = run(JSON.stringify({ result: { mapping: [] } }, null, 2), 5);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no aligned pairs/);
});

test("reads what the CLI really prints, not just the library's JSON", () => {
  const cli = path.join(root, "apps/cli/dist/index.js");
  const out = execFileSync(process.execPath, [cli, "schema", "moldesk.compare"], { encoding: "utf8" });
  assert.ok(JSON.parse(out).properties.result.properties.mapping, "the schema the awk relies on still has result.mapping");
});

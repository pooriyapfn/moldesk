import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PUBLISH_ORDER, checkRelease, parseTag } from "./release-lib.mjs";

function fixture(versions, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-lib-"));
  const write = (dir, pkg) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "package.json"), JSON.stringify(pkg));
  };
  for (const dir of PUBLISH_ORDER) write(dir, { name: `@moldesk/${path.basename(dir)}`, version: versions[dir] ?? "1.2.3" });
  write("apps/website", { name: "website", version: "0.1.0", private: true });
  for (const [dir, pkg] of Object.entries(extra)) write(dir, pkg);
  return root;
}

test("parseTag accepts releases and prereleases, rejects everything else", () => {
  assert.deepEqual(parseTag("v1.2.3"), { version: "1.2.3", prerelease: false });
  assert.deepEqual(parseTag("v1.2.3-rc.1"), { version: "1.2.3-rc.1", prerelease: true });
  for (const bad of ["1.2.3", "v1.2", "v1.2.3.4", "vlatest", "", undefined]) assert.throws(() => parseTag(bad));
});

test("checkRelease passes when every package matches the tag", () => {
  const result = checkRelease(fixture({}), "v1.2.3");
  assert.deepEqual(result.errors, []);
  assert.equal(result.version, "1.2.3");
});

test("checkRelease names each package whose version differs from the tag", () => {
  const root = fixture({ "packages/core": "1.2.2", "apps/cli": "1.2.2" });
  const { errors } = checkRelease(root, "v1.2.3");
  assert.equal(errors.length, 2);
  assert.match(errors[0], /@moldesk\/core is at 1\.2\.2 but the tag is v1\.2\.3/);
});

test("checkRelease rejects a malformed tag", () => {
  assert.match(checkRelease(fixture({}), "release-1").errors[0], /must look like/);
});

test("checkRelease flags a new publishable package missing from PUBLISH_ORDER, but ignores private ones", () => {
  const root = fixture({}, { "packages/newthing": { name: "@moldesk/newthing", version: "1.2.3" } });
  const { errors } = checkRelease(root, "v1.2.3");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /packages\/newthing is publishable but missing/);
});

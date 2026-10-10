import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeBundleSha256, sha256Hex, TEMPLATE_VERSION, type ViewerBundle } from "./bundle.js";
import { exportReport } from "./export.js";
import { decodeEnvelope, extractEnvelope } from "./report.js";
import { applyUpdate, planUpdate } from "./update.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures");

function bundle(tag: string): ViewerBundle {
  const js = `/* ${tag} */`;
  const css = `/* css ${tag} */`;
  const assets = { "viewer.js": sha256Hex(js), "viewer.css": sha256Hex(css) } as const;
  return {
    js,
    css,
    metadata: {
      viewerVersion: "1.0.0",
      molstarVersion: "5.12.0",
      templateVersion: TEMPLATE_VERSION,
      compatible: { envelopeVersions: [1], schemaVersions: [1] },
      assets,
      bundleSha256: computeBundleSha256(assets),
    },
  };
}

const FORMATS: Record<string, "pdb" | "mmcif" | "sdf" | "json"> = { ".pdb": "pdb", ".cif": "mmcif", ".sdf": "sdf", ".json": "json" };
const files = readdirSync(fixtures).filter((f) => f.slice(f.lastIndexOf(".")) in FORMATS);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "moldesk-fixtures-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("real structure fixtures", () => {
  it("covers the scientific edge cases the browser smoke relies on", () => {
    for (const f of ["1AAY.pdb", "1D3Z-3models.pdb", "1IGT-VH.pdb", "3HZ7.pdb", "HEM-only.pdb", "1CRN.cif", "1BNA.cif"]) {
      expect(files).toContain(f);
    }
  });

  it.each(files)("%s: original bytes survive export, decode, and a viewer update unchanged", async (name) => {
    const original = new Uint8Array(readFileSync(path.join(fixtures, name)));
    const format = FORMATS[name.slice(name.lastIndexOf("."))];
    const exported = exportReport(
      {
        title: name,
        resources: [{ id: "r", label: name, format, bytes: original }],
        scenes: format === "json" ? [] : [{ id: "s", title: name, structures: [{ id: "a", resourceId: "r" }] }],
        panels: [],
        provenance: {},
      },
      bundle("a"),
    );
    const before = decodeEnvelope(extractEnvelope(exported.html));
    expect(before.resources[0].sha256).toBe(sha256Hex(original));
    expect(Buffer.from(before.resources[0].data, "base64").equals(Buffer.from(original))).toBe(true);

    const file = path.join(dir, "r.html");
    writeFileSync(file, exported.html);
    await applyUpdate(await planUpdate(file, { bundle: bundle("b") }));
    const after = decodeEnvelope(extractEnvelope(readFileSync(file, "utf8")));
    expect(after.resources).toEqual(before.resources);
    expect(after.scenes).toEqual(before.scenes);
  });
});

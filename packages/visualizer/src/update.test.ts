import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeBundleSha256, sha256Hex, TEMPLATE_VERSION, type ViewerBundle } from "./bundle.js";
import { exportReport, writeFileExclusive } from "./export.js";
import { decodeEnvelope, extractEnvelope, ReportFormatError } from "./report.js";
import { applyUpdate, planUpdate } from "./update.js";

function fakeBundle(tag: string, version = "1.0.0"): ViewerBundle {
  const js = `/* viewer ${tag} */ window.__v=${JSON.stringify(tag)};`;
  const css = `/* css ${tag} */ body{margin:0}`;
  const assets = { "viewer.js": sha256Hex(js), "viewer.css": sha256Hex(css) } as const;
  return {
    js,
    css,
    metadata: {
      viewerVersion: version,
      molstarVersion: "5.12.0",
      templateVersion: TEMPLATE_VERSION,
      compatible: { envelopeVersions: [1], schemaVersions: [1] },
      assets,
      bundleSha256: computeBundleSha256(assets),
    },
  };
}

const PDB = new TextEncoder().encode("ATOM      1  N   ALA A   1      11.104  13.207   2.100  1.00 20.00           N\n");

function input(title = "My protein") {
  return {
    title,
    resources: [{ id: "r1", label: "p.pdb", format: "pdb" as const, bytes: PDB }],
    scenes: [{ id: "s1", title: "Structure", structures: [{ id: "a", resourceId: "r1" }] }],
    panels: [],
    provenance: {},
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "moldesk-viz-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("envelope", () => {
  it("round-trips and survives hostile titles and molecular comments", () => {
    const evil = '</script><script>alert(1)</script><img src=x onerror="y">';
    const bytes = new TextEncoder().encode(`REMARK ${evil}\nATOM\n`);
    const out = exportReport(
      { ...input(evil), resources: [{ id: "r1", label: evil, format: "pdb", bytes }] },
      fakeBundle("a"),
    );
    // The only script elements are the inert envelope and the trusted viewer.
    expect(out.html.match(/<script/g)).toHaveLength(2);
    expect(out.html).not.toContain(evil);
    const report = decodeEnvelope(extractEnvelope(out.html));
    expect(report.title).toBe(evil);
    expect(Buffer.from(report.resources[0].data, "base64").equals(Buffer.from(bytes))).toBe(true);
    expect(report.resources[0].sha256).toBe(sha256Hex(bytes));
  });

  it("emits a CSP with matching hashes and no network allowances", () => {
    const b = fakeBundle("a");
    const { html } = exportReport(input(), b);
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1].replace(/&#39;/g, "'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain(`'sha256-${Buffer.from(sha256Hex(b.js), "hex").toString("base64")}'`);
  });

  it("rejects duplicate envelopes, non-reports, and tampered payloads", () => {
    const { html } = exportReport(input(), fakeBundle("a"));
    const block = /<script type="application\/json" id="moldesk-report">[\s\S]*?<\/script>/.exec(html)![0];
    expect(() => extractEnvelope(html.replace("</body>", `${block}</body>`))).toThrow(/more than one/);
    expect(() => extractEnvelope("<html><body>hi</body></html>")).toThrow(ReportFormatError);
    const env = extractEnvelope(html);
    expect(() => decodeEnvelope({ ...env, payloadSha256: "0".repeat(64) })).toThrow(/digest/);
    expect(() => decodeEnvelope({ ...env, payload: "!!!" })).toThrow(/base64/);
  });
});

describe("update", () => {
  async function writeReport(bundle: ViewerBundle, name = "report.html") {
    const file = path.join(dir, name);
    writeFileSync(file, exportReport(input(), bundle).html);
    return file;
  }

  it("is a no-op for the same bundle", async () => {
    const b = fakeBundle("a");
    const file = await writeReport(b);
    expect((await planUpdate(file, { bundle: b })).status).toBe("noop");
  });

  it("does not trust same-version metadata when the scripts differ", async () => {
    const b = fakeBundle("a");
    const file = await writeReport(b);
    writeFileSync(file, readFileSync(file, "utf8").replace("window.__v", "window.__evil"));
    expect((await planUpdate(file, { bundle: b })).status).toBe("replace");
  });

  it("replaces with an older or newer local bundle, keeps payload, backs up the original", async () => {
    const oldFile = await writeReport(fakeBundle("new", "2.0.0"));
    const before = readFileSync(oldFile);
    const payloadBefore = extractEnvelope(before.toString("utf8")).payload;

    const plan = await planUpdate(oldFile, { bundle: fakeBundle("old", "1.0.0") });
    expect(plan.status).toBe("replace");
    const result = await applyUpdate(plan);

    const after = readFileSync(oldFile, "utf8");
    expect(after).toContain("viewer old");
    expect(extractEnvelope(after).payload).toBe(payloadBefore);
    expect(extractEnvelope(after).viewer.version).toBe("1.0.0");
    expect(readFileSync(result.backupPath!).equals(before)).toBe(true);
    expect((await planUpdate(oldFile, { bundle: fakeBundle("old", "1.0.0") })).status).toBe("noop");
  });

  it("never overwrites an existing backup", async () => {
    const file = await writeReport(fakeBundle("a"));
    writeFileSync(path.join(dir, "report.backup.html"), "precious");
    const result = await applyUpdate(await planUpdate(file, { bundle: fakeBundle("b") }));
    expect(readFileSync(path.join(dir, "report.backup.html"), "utf8")).toBe("precious");
    expect(path.basename(result.backupPath!)).toBe("report.backup-1.html");
  });

  it("writes --output separately, leaves the original, refuses to overwrite", async () => {
    const file = await writeReport(fakeBundle("a"));
    const before = readFileSync(file);
    const out = path.join(dir, "out.html");
    const result = await applyUpdate(await planUpdate(file, { bundle: fakeBundle("b"), output: out }));
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("viewer b");
    await expect(applyUpdate(await planUpdate(file, { bundle: fakeBundle("b"), output: out }))).rejects.toMatchObject({
      code: "OUTPUT_EXISTS",
    });
  });

  it("copies on no-op with --output", async () => {
    const b = fakeBundle("a");
    const file = await writeReport(b);
    const out = path.join(dir, "copy.html");
    const result = await applyUpdate(await planUpdate(file, { bundle: b, output: out }));
    expect(result.status).toBe("copied");
    expect(readFileSync(out).equals(readFileSync(file))).toBe(true);
  });

  it("rejects when the file changed after planning, leaving it untouched", async () => {
    const file = await writeReport(fakeBundle("a"));
    const plan = await planUpdate(file, { bundle: fakeBundle("b") });
    writeFileSync(file, readFileSync(file, "utf8") + "<!-- edited -->");
    const edited = readFileSync(file);
    await expect(applyUpdate(plan)).rejects.toMatchObject({ code: "REPORT_CONFLICT" });
    expect(readFileSync(file).equals(edited)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes("backup") || n.includes(".tmp-"))).toEqual([]);
  });

  it("preserves file mode", async () => {
    const file = await writeReport(fakeBundle("a"));
    chmodSync(file, 0o600);
    await applyUpdate(await planUpdate(file, { bundle: fakeBundle("b") }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rejects symlinks, ordinary HTML, and unsupported schemas without touching them", async () => {
    const real = await writeReport(fakeBundle("a"));
    const link = path.join(dir, "link.html");
    symlinkSync(real, link);
    await expect(planUpdate(link, { bundle: fakeBundle("b") })).rejects.toThrow(/symbolic link/);

    const plain = path.join(dir, "plain.html");
    writeFileSync(plain, "<html><script>alert(1)</script></html>");
    await expect(planUpdate(plain, { bundle: fakeBundle("b") })).rejects.toThrow(/not a MoleculeDesk/);

    const b = fakeBundle("b");
    b.metadata.compatible.envelopeVersions = [99];
    expect((await planUpdate(real, { bundle: b })).status).toBe("unsupported");
  });
});

describe("writeFileExclusive", () => {
  it("refuses an existing destination and cleans temp files", async () => {
    const dest = path.join(dir, "x.html");
    await writeFileExclusive(dest, "one");
    await expect(writeFileExclusive(dest, "two")).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    expect(readFileSync(dest, "utf8")).toBe("one");
    expect(readdirSync(dir)).toEqual(["x.html"]);
  });
});

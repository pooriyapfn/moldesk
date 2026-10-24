import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerViewCommand } from "./view.js";

const state = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("@moldesk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/core")>();
  return { ...actual, openInBrowser: state.open };
});

const PDB = "ATOM      1  N   ALA A   1      11.104  13.207   2.100  1.00 20.00           N\n";

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-cli-view-"));
  process.env.MOLDESK_HOME = path.join(dir, "home");
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  process.exitCode = undefined;
  state.open.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MOLDESK_HOME;
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerViewCommand(program);
  await program.parseAsync(args, { from: "user" });
}

const structure = (name = "p.pdb") => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, PDB);
  return p;
};

describe("view", () => {
  it("prints the path and an encoded file URL, and does not open a browser by default", async () => {
    const weird = path.join(dir, "my protein #1.pdb");
    fs.writeFileSync(weird, PDB);
    await run("view", weird, "--output", path.join(dir, "r e p.html"));
    expect(out[0]).toContain(path.join(dir, "r e p.html"));
    expect(out[1]).toContain("file://");
    expect(out[1]).toContain("r%20e%20p.html");
    expect(state.open).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("emits exactly one JSON object on stdout", async () => {
    await run("view", structure(), "--json", "--output", path.join(dir, "j.html"));
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed).toMatchObject({ status: "created", format: "pdb", warnings: [] });
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(err).toEqual([]);
  });

  it("passes the report path to the opener and succeeds", async () => {
    state.open.mockResolvedValue({ opened: true });
    const target = path.join(dir, "o.html");
    await run("view", structure(), "--open", "--output", target, "--json");
    expect(state.open).toHaveBeenCalledWith(target);
    expect(JSON.parse(out[0]).opened).toBe(true);
  });

  it("keeps the report and exit 0 when opening fails", async () => {
    state.open.mockResolvedValue({ opened: false, error: "no display" });
    const target = path.join(dir, "w.html");
    await run("view", structure(), "--open", "--output", target);
    expect(fs.existsSync(target)).toBe(true);
    expect(err.join("\n")).toContain("no display");
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["bad extension", () => structure("a.txt"), 2],
    ["missing file", () => path.join(dir, "missing.pdb"), 2],
    ["URL", () => "https://x.test/a.pdb", 2],
  ])("exits 2 for %s", async (_n, make, code) => {
    await run("view", make(), "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "INVALID_VIEW_INPUT" });
    expect(process.exitCode).toBe(code);
  });

  it("refuses to overwrite --output with exit 2", async () => {
    const target = path.join(dir, "exists.html");
    fs.writeFileSync(target, "keep");
    await run("view", structure(), "--output", target);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
    expect(process.exitCode).toBe(2);
  });

  describe("highlights and coloring", () => {
    const CRN = path.resolve(import.meta.dirname, "../../../../packages/visualizer/test/fixtures/1CRN.pdb");
    const components = (file: string) => {
      const payload = /"payload":"([^"]+)"/.exec(fs.readFileSync(file, "utf8"))![1];
      return JSON.parse(Buffer.from(payload, "base64").toString()).scenes[0].components as Array<Record<string, any>>;
    };

    it("adds a colored highlight per --highlight/--color pair", async () => {
      const target = path.join(dir, "h.html");
      await run("view", CRN, "--highlight", "A:5-9", "--highlight", "A:20", "--color", "#ff5500", "--color", "#00c2ff", "--output", target, "--json");
      expect(JSON.parse(out[0])).toMatchObject({ status: "created" });
      const hl = components(target).filter((c) => c.id.startsWith("highlight-"));
      expect(hl.map((c) => [c.color, c.selection.residues.length])).toEqual([["#ff5500", 5], ["#00c2ff", 1]]);
    });

    it("colors by pLDDT only with a known source", async () => {
      await run("view", CRN, "--color-by", "plddt", "--output", path.join(dir, "no.html"), "--json");
      expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "PLDDT_UNAVAILABLE" });
      expect(process.exitCode).toBe(2);
      expect(fs.existsSync(path.join(dir, "no.html"))).toBe(false);

      out.length = 0;
      process.exitCode = undefined;
      const target = path.join(dir, "p.html");
      await run("view", CRN, "--color-by", "plddt", "--bfactor-is-plddt", "--output", target, "--json");
      expect(components(target).some((c) => c.id.startsWith("plddt-"))).toBe(true);
    });

    it("reads a scene file, including the structure path", async () => {
      fs.copyFileSync(CRN, path.join(dir, "crn.pdb"));
      const scene = path.join(dir, "scene.json");
      fs.writeFileSync(scene, JSON.stringify({ structure: "crn.pdb", components: [{ selector: "A:1-3", color: "#123456" }] }));
      const target = path.join(dir, "s.html");
      await run("view", "--scene", scene, "--output", target, "--json");
      expect(components(target).at(-1)).toMatchObject({ id: "highlight-1", color: "#123456" });
    });

    it.each([
      ["a highlight that matches nothing", ["--highlight", "A:999"], "SELECTOR_NO_MATCH"],
      ["an invalid selector", ["--highlight", "A:9-1"], "INVALID_SELECTOR"],
      ["--color without --highlight", ["--color", "#ff5500"], "INVALID_VIEW_INPUT"],
      ["a bad color", ["--highlight", "A", "--color", "orange"], "INVALID_SCENE"],
      ["a bad --color-by", ["--color-by", "rainbow"], "INVALID_SCENE"],
    ])("exits 2 for %s and writes nothing", async (_name, args, code) => {
      const target = path.join(dir, "bad.html");
      await run("view", CRN, ...args, "--output", target, "--json");
      expect(JSON.parse(out[0])).toMatchObject({ status: "error", code });
      expect(process.exitCode).toBe(2);
      expect(fs.existsSync(target)).toBe(false);
    });

    it("explains an unmatched highlight with the available chains", async () => {
      await run("view", CRN, "--highlight", "B:1", "--output", path.join(dir, "n.html"), "--json");
      expect(JSON.parse(out[0])).toMatchObject({
        status: "error",
        code: "SELECTOR_NO_MATCH",
        message: expect.stringContaining('there is no chain "B"'),
        details: { reason: "no-chain", available: [{ chainId: "A", type: "protein", residues: "1-46" }] },
      });
    });

    it("exits 2 when no structure is given", async () => {
      await run("view", "--json");
      expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "INVALID_VIEW_INPUT" });
      expect(process.exitCode).toBe(2);
    });
  });
});

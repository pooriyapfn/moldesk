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
});

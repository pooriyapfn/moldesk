import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerViewCommand } from "./view.js";
import { registerVisualizerCommand } from "./visualizer.js";

const state = vi.hoisted(() => ({ answer: "n", questions: [] as string[], open: vi.fn() }));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (q: string) => {
      state.questions.push(q);
      return state.answer;
    },
    close: () => undefined,
  }),
}));
vi.mock("@moldesk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/core")>();
  return { ...actual, openInBrowser: state.open };
});

const PDB = "ATOM      1  N   ALA A   1      11.104  13.207   2.100  1.00 20.00           N\n";

let dir: string;
let out: string[];
let err: string[];
let report: string;

function setTty(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerViewCommand(program);
  registerVisualizerCommand(program);
  await program.parseAsync(args, { from: "user" });
}

/** A report whose HTML no longer equals the trusted reconstruction (as an older/other build would). */
function makeStale(file: string) {
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("<body>", "<body><!-- older viewer -->"));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-cli-update-"));
  process.env.MOLDESK_HOME = path.join(dir, "home");
  fs.writeFileSync(path.join(dir, "p.pdb"), PDB);
  report = path.join(dir, "report.html");
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  await run("view", path.join(dir, "p.pdb"), "--output", report);
  out.length = 0;
  err.length = 0;
  process.exitCode = undefined;
  state.answer = "n";
  state.questions = [];
  state.open.mockReset();
  setTty(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MOLDESK_HOME;
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const backups = () => fs.readdirSync(dir).filter((n) => n.includes("backup"));

describe("visualizer update", () => {
  it("is a successful no-op with no prompt when the viewer already matches", async () => {
    const before = fs.readFileSync(report);
    await run("visualizer", "update", report);
    expect(out).toEqual(["This report already uses your current viewer."]);
    expect(state.questions).toEqual([]);
    expect(fs.readFileSync(report).equals(before)).toBe(true);
    expect(backups()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["no TTY", false, []],
    ["--json even with a TTY", true, ["--json"]],
  ])("requires --yes: %s", async (_n, tty, extra) => {
    makeStale(report);
    const before = fs.readFileSync(report);
    setTty(tty);
    await run("visualizer", "update", report, ...extra);
    expect(process.exitCode).toBe(2);
    expect(state.questions).toEqual([]);
    expect(fs.readFileSync(report).equals(before)).toBe(true);
    expect(backups()).toEqual([]);
    if (extra.length) expect(JSON.parse(out[0]).status).toBe("confirmation-required");
  });

  it("updates with --yes, keeps a backup of the original bytes, and prints the success text", async () => {
    makeStale(report);
    const before = fs.readFileSync(report);
    await run("visualizer", "update", report, "--yes");
    expect(out[0]).toBe("Viewer updated. Refresh your report to see the changes.");
    expect(out[1]).toMatch(/^Backup saved: .*report\.backup\.html$/);
    expect(fs.readFileSync(path.join(dir, "report.backup.html")).equals(before)).toBe(true);
    expect(fs.readFileSync(report, "utf8")).not.toContain("older viewer");
    expect(process.exitCode).toBeUndefined();
  });

  it("asks the documented question and proceeds on y", async () => {
    makeStale(report);
    setTty(true);
    state.answer = "y";
    await run("visualizer", "update", report);
    const q = state.questions[0];
    expect(q).toContain("Update this report’s viewer?");
    expect(q).toContain(`Report: ${report}`);
    expect(q).toContain("Your structures and results will stay unchanged.");
    expect(q).toContain("A backup of your current report will be saved.");
    expect(q).toContain("Continue? [y/N]");
    expect(backups()).toHaveLength(1);
  });

  it("treats a declined confirmation as a successful no-op", async () => {
    makeStale(report);
    const before = fs.readFileSync(report);
    setTty(true);
    state.answer = "n";
    await run("visualizer", "update", report);
    expect(out.join("\n")).toContain("Cancelled");
    expect(fs.readFileSync(report).equals(before)).toBe(true);
    expect(backups()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("--output saves a separate file, leaves the original alone, and changes the prompt wording", async () => {
    makeStale(report);
    const before = fs.readFileSync(report);
    const target = path.join(dir, "updated.html");
    setTty(true);
    state.answer = "yes";
    await run("visualizer", "update", report, "--output", target);
    expect(state.questions[0]).toContain("Your updated report will be saved as a separate file.");
    expect(state.questions[0]).toContain(`Save as: ${target}`);
    expect(state.questions[0]).not.toContain("backup");
    expect(fs.readFileSync(report).equals(before)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).not.toContain("older viewer");
    expect(backups()).toEqual([]);
  });

  it("copies on no-op with --output after confirmation, and never overwrites an existing --output", async () => {
    const target = path.join(dir, "copy.html");
    await run("visualizer", "update", report, "--output", target, "--yes");
    expect(fs.readFileSync(target).equals(fs.readFileSync(report))).toBe(true);
    process.exitCode = undefined;
    await run("visualizer", "update", report, "--output", target, "--yes");
    expect(process.exitCode).toBe(2);
  });

  it("rejects ordinary HTML and unsupported input with exit 2, unchanged", async () => {
    const plain = path.join(dir, "plain.html");
    fs.writeFileSync(plain, "<html><script>alert(1)</script></html>");
    await run("visualizer", "update", plain, "--yes", "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "INVALID_REPORT" });
    expect(process.exitCode).toBe(2);
    expect(fs.readFileSync(plain, "utf8")).toBe("<html><script>alert(1)</script></html>");
  });

  it("opens only after a successful update; open failure is a warning, not a failure", async () => {
    makeStale(report);
    state.open.mockResolvedValue({ opened: false, error: "no display" });
    await run("visualizer", "update", report, "--yes", "--open", "--json");
    const result = JSON.parse(out[0]);
    expect(state.open).toHaveBeenCalledWith(report);
    expect(result).toMatchObject({ status: "updated", opened: false });
    expect(result.warnings[0].code).toBe("OPEN_FAILED");
    expect(process.exitCode).toBeUndefined();
  });

  it("does not open when the update is refused", async () => {
    makeStale(report);
    await run("visualizer", "update", report, "--open");
    expect(state.open).not.toHaveBeenCalled();
  });
});

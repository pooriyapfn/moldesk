import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { validateEnvelope } from "@moldesk/core";
import { registerFetchCommand } from "./fetch.js";

const state = vi.hoisted(() => ({ overrides: {} as object }));

// The real command and the real core, pointed at a local server and a scratch MOLDESK_HOME.
vi.mock("@moldesk/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moldesk/core")>();
  return { ...actual, fetchStructure: (spec: string, options: object) => actual.fetchStructure(spec, { ...options, ...state.overrides }) };
});

const CIF = "data_1M17\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\nATOM 1\n";

let dir: string;
let server: http.Server;
let hits: string[];
let out: string[];
let err: string[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-cli-fetch-"));
  hits = [];
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/download/1M17.cif") res.writeHead(200, { "last-modified": "Mon, 22 Sep 2025 00:17:19 GMT" }).end(CIF);
    else res.writeHead(404).end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = { host: `127.0.0.1:${(server.address() as AddressInfo).port}`, scheme: "http" as const };
  const { getMoldeskPaths } = await import("@moldesk/core");
  state.overrides = { paths: getMoldeskPaths({ MOLDESK_HOME: path.join(dir, "home") }), endpoints: { pdb: endpoint, afdb: endpoint, uniprot: endpoint } };
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerFetchCommand(program);
  await program.parseAsync(["fetch", ...args], { from: "user" });
}

describe("moldesk fetch", () => {
  it("prints exactly one valid moldesk.fetch envelope with --json, and the second run uses the cache", async () => {
    await run("pdb:1M17", "--json");
    expect(out).toHaveLength(1);
    const envelope = validateEnvelope(JSON.parse(out[0]), "moldesk.fetch");
    expect(envelope.result).toMatchObject({ source: "pdb", id: "1M17", fromCache: false });

    out.length = 0;
    await run("pdb:1M17", "--json");
    expect(JSON.parse(out[0]).result.fromCache).toBe(true);
    expect(hits).toEqual(["/download/1M17.cif"]);
  });

  it("prints the path, hash, source, version and license without --json", async () => {
    await run("pdb:1M17");
    const text = out.join("\n");
    expect(text).toContain("pdb:1M17 (downloaded)");
    expect(text).toMatch(/SHA-256 [0-9a-f]{64}/);
    expect(text).toContain("(2025-09-22T00:17:19.000Z)");
    expect(text).toContain("License CC0 1.0");
  });

  it("copies into --output and refuses to overwrite it", async () => {
    const target = path.join(dir, "out");
    await run("pdb:1M17", "--output", target, "--json");
    expect(fs.readdirSync(target).sort()).toEqual(["1M17.cif", "1M17.cif.provenance.json"]);
    out.length = 0;
    await run("pdb:1M17", "--output", target, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "OUTPUT_EXISTS" });
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["an invalid id", ["pdb:../x"], "INVALID_FETCH_SPEC", 2],
    ["an unknown source", ["foo:1M17"], "INVALID_FETCH_SPEC", 2],
    ["an unknown entry", ["pdb:2ZZZ"], "FETCH_NOT_FOUND", 2],
    ["a bad --format", ["pdb:1M17", "--format", "xml"], "INVALID_FETCH_ARGS", 2],
    ["--format with uniprot", ["uniprot:P00533", "--format", "pdb"], "INVALID_FETCH_ARGS", 2],
  ])("exits %s for %s", async (_name, args, code, exit) => {
    await run(...args, "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code });
    expect(process.exitCode).toBe(exit);
  });

  it("makes no request for an invalid id", async () => {
    await run("pdb:1M17/..");
    expect(hits).toEqual([]);
    expect(err.join("\n")).toContain("not a valid PDB id");
  });

  it("exits 10 when the service misbehaves", async () => {
    server.removeAllListeners("request");
    server.on("request", (_req, res) => void res.writeHead(200).end("<html>nope</html>"));
    await run("pdb:1M17", "--json");
    expect(JSON.parse(out[0])).toMatchObject({ status: "error", code: "FETCH_BAD_CONTENT" });
    expect(process.exitCode).toBe(10);
  });
});

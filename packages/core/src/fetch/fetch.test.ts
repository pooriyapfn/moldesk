import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMoldeskPaths } from "@moldesk/runtime";
import { validateEnvelope } from "../schemas/envelope.js";
import { fetchStructure, type FetchOptions } from "./fetch.js";
import { parseFetchSpec } from "./sources.js";

const CIF = (block: string) => `data_${block}\n#\nloop_\n_atom_site.group_PDB\n_atom_site.id\nATOM 1\n`;
const PDB = "HEADER    TEST\nATOM      1  N   ALA A   1      11.104  13.207   2.100  1.00 20.00           N\nEND\n";
const FASTA = ">sp|P00533|EGFR_HUMAN Epidermal growth factor receptor\nMRPSGTAGAALLALLAALCPASRALEEKKVCQGTSNKLTQLGTFEDHFLSLQRMFNNCEV\n";
const AF_API = (extra: object = {}) =>
  JSON.stringify([
    { entryId: "AF-P00533-4-F1", cifUrl: "https://alphafold.ebi.ac.uk/files/AF-P00533-4-F1-model_v6.cif" },
    {
      entryId: "AF-P00533-F1",
      uniprotAccession: "P00533",
      latestVersion: 6,
      modelCreatedDate: "2025-08-01T00:00:00Z",
      cifUrl: "https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.cif",
      pdbUrl: "https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb",
      ...extra,
    },
  ]);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
interface Mock {
  host: string;
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
}

async function serve(routes: Record<string, Handler | string>): Promise<Mock> {
  const requests: Mock["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const route = routes[req.url ?? ""];
    if (typeof route === "function") return route(req, res);
    if (route === undefined) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/plain" }).end(route);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

let dir: string;
let servers: Mock[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-fetch-"));
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const paths = () => getMoldeskPaths({ MOLDESK_HOME: path.join(dir, "home") });
const mock = async (routes: Record<string, Handler | string>) => {
  const s = await serve(routes);
  servers.push(s);
  return s;
};
const opts = (s: Mock, extra: Partial<FetchOptions> = {}): FetchOptions => ({
  paths: paths(),
  endpoints: { pdb: { host: s.host, scheme: "http" }, afdb: { host: s.host, scheme: "http" }, uniprot: { host: s.host, scheme: "http" } },
  ...extra,
});
const cacheFiles = (source: string, id: string) => {
  const d = path.join(paths().cache, "fetch", source, id);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};
const code = (promise: Promise<unknown>) => promise.then(() => "ok", (e: { code?: string }) => e.code);

describe("ids are validated before any network call or path join", () => {
  it.each([
    "pdb:1M17", "PDB:1m17", "pdb:2xyz", "afdb:P00533", "afdb:p00533", "uniprot:Q9Y6K9", "uniprot:A0A0C5B5G6", "uniprot:O00533",
  ])("accepts %s", (text) => {
    expect(parseFetchSpec(text).id).toBe(text.split(":")[1].toUpperCase());
  });

  it.each([
    "../x", "pdb:../x", "pdb:1M17/..", "pdb:1M17/../2ABC", "pdb:%2e%2e%2f", "pdb:1m17%2f", "pdb:1M1", "pdb:1M177", "pdb:0ABC", "pdb: 1M17", "pdb:1M17\n",
    "pdb:1M1\u0000", "pdb:1M1/", "pdb:", "pdb", ":1M17", "ftp:1M17", "http:1M17", "pdb:pdb:1M17", "afdb:P0053", "afdb:P005333", "afdb:P00533-2", "afdb:../P00533",
    "uniprot:1M17", "uniprot:P00533.fasta", "uniprot:P00533/../Q9Y6K9", "uniprot:P00533?x=1", "afdb:A0A0C5B5G6X",
  ])("rejects %j without touching the network or the cache", async (text) => {
    const s = await mock({});
    expect(await code(fetchStructure(text, opts(s)))).toBe("INVALID_FETCH_SPEC");
    expect(s.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(paths().cache, "fetch"))).toBe(false);
  });

  it("rejects --format for uniprot", async () => {
    expect(await code(fetchStructure("uniprot:P00533", { format: "pdb" }))).toBe("INVALID_FETCH_ARGS");
  });
});

describe("a successful fetch", () => {
  it("writes the file and its provenance atomically into the cache and returns a valid envelope", async () => {
    const s = await mock({
      "/download/1M17.cif": (_req, res) => res.writeHead(200, { "last-modified": "Mon, 22 Sep 2025 00:17:19 GMT" }).end(CIF("1M17")),
    });
    const now = () => new Date("2026-01-02T03:04:05.000Z");
    const envelope = await fetchStructure("pdb:1m17", opts(s, { now }));
    validateEnvelope(envelope, "moldesk.fetch");
    const r = envelope.result;
    expect(r).toMatchObject({ source: "pdb", id: "1M17", format: "mmcif", fromCache: false });
    expect(r.files[0].path).toBe(path.join(paths().cache, "fetch", "pdb", "1M17", "1M17.cif"));
    expect(fs.readFileSync(r.files[0].path, "utf8")).toBe(CIF("1M17"));
    expect(cacheFiles("pdb", "1M17")).toEqual(["1M17.cif", "1M17.cif.provenance.json"]); // no temp leftovers
    expect(r.provenance).toMatchObject({
      url: `http://${s.host}/download/1M17.cif`,
      retrievedAt: "2026-01-02T03:04:05.000Z",
      sourceVersion: "2025-09-22T00:17:19.000Z",
      sourceVersionKind: "http-last-modified",
      license: { name: "CC0 1.0" },
      sizeBytes: Buffer.byteLength(CIF("1M17")),
    });
    expect(r.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(fs.readFileSync(`${r.files[0].path}.provenance.json`, "utf8"))).toEqual(r.provenance);
  });

  it("sends no credentials and identifies itself", async () => {
    const s = await mock({ "/download/1M17.pdb": PDB });
    await fetchStructure("pdb:1M17", opts(s, { format: "pdb" }));
    expect(Object.keys(s.requests[0].headers).filter((h) => /cookie|authorization/i.test(h))).toEqual([]);
    expect(s.requests[0].headers["user-agent"]).toMatch(/^moldesk\//);
  });

  it("fetches PDB-format files and UniProt FASTA with the release as the version", async () => {
    const s = await mock({
      "/download/1M17.pdb": PDB,
      "/uniprotkb/P00533.fasta": (_req, res) => res.writeHead(200, { "x-uniprot-release": "2026_03", "x-uniprot-release-date": "02-September-2026" }).end(FASTA),
    });
    expect((await fetchStructure("pdb:1M17", opts(s, { format: "pdb" }))).result).toMatchObject({ format: "pdb", files: [{ name: "1M17.pdb" }] });
    const fasta = (await fetchStructure("uniprot:P00533", opts(s))).result;
    expect(fasta).toMatchObject({ format: "fasta", provenance: { sourceVersion: "2026_03", sourceVersionKind: "uniprot-release", details: { releaseDate: "02-September-2026" }, license: { name: "CC-BY-4.0" } } });
    expect(fasta.files[0].name).toBe("P00533.fasta");
  });

  it("follows a redirect within the same host", async () => {
    const s = await mock({
      "/uniprotkb/P00533.fasta": (_req, res) => res.writeHead(303, { location: "/uniprotkb/moved/P00533.fasta" }).end(),
      "/uniprotkb/moved/P00533.fasta": FASTA,
    });
    const result = (await fetchStructure("uniprot:P00533", opts(s))).result;
    expect(result.provenance.url).toBe(`http://${s.host}/uniprotkb/moved/P00533.fasta`);
  });

  it("resolves the AlphaFold DB file through its API and records the model version", async () => {
    const s = await mock({
      "/api/prediction/P00533": AF_API(),
      "/files/AF-P00533-F1-model_v6.cif": CIF("AF-P00533-F1"),
      "/files/AF-P00533-F1-model_v6.pdb": PDB,
    });
    const envelope = await fetchStructure("afdb:p00533", opts(s));
    expect(envelope.result).toMatchObject({
      format: "mmcif",
      files: [{ name: "AF-P00533-F1.cif" }],
      provenance: { sourceVersion: "v6", sourceVersionKind: "alphafold-model-version", details: { entryId: "AF-P00533-F1", modelCreatedDate: "2025-08-01T00:00:00Z" }, license: { name: "CC-BY-4.0" } },
    });
    expect(envelope.result.provenance.apiUrl).toBe(`http://${s.host}/api/prediction/P00533`);
    expect(envelope.warnings.map((w) => w.code)).toEqual(["PREDICTED_STRUCTURE"]);
    expect((await fetchStructure("afdb:P00533", opts(s, { format: "pdb" }))).result.files[0].name).toBe("AF-P00533-F1.pdb");
  });
});

describe("downloads that are rejected leave nothing behind", () => {
  const nothing = (source: string, id: string) => expect(cacheFiles(source, id)).toEqual([]);

  it("404", async () => {
    const s = await mock({});
    expect(await code(fetchStructure("pdb:1ABC", opts(s)))).toBe("FETCH_NOT_FOUND");
    nothing("pdb", "1ABC");
  });

  it("an HTTP error", async () => {
    const s = await mock({ "/download/1ABC.cif": (_r, res) => void res.writeHead(503).end("busy") });
    expect(await code(fetchStructure("pdb:1ABC", opts(s)))).toBe("FETCH_HTTP_ERROR");
    nothing("pdb", "1ABC");
  });

  it("an oversize response, declared up front", async () => {
    const s = await mock({ "/download/1ABC.cif": CIF("1ABC") + "x".repeat(5000) });
    expect(await code(fetchStructure("pdb:1ABC", opts(s, { maxBytes: 1000 })))).toBe("FETCH_TOO_LARGE");
    nothing("pdb", "1ABC");
  });

  it("an oversize response that never declares its size", async () => {
    const s = await mock({
      "/download/1ABC.cif": (_r, res) => {
        res.writeHead(200);
        res.write(CIF("1ABC"));
        for (let i = 0; i < 50; i++) res.write("y".repeat(100));
        res.end();
      },
    });
    expect(await code(fetchStructure("pdb:1ABC", opts(s, { maxBytes: 1000 })))).toBe("FETCH_TOO_LARGE");
    nothing("pdb", "1ABC");
  });

  it("a small gzip body that inflates beyond the limit", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(5_000_000, 0x61));
    expect(bomb.length).toBeLessThan(10_000);
    const s = await mock({ "/download/1ABC.cif": (_r, res) => void res.writeHead(200, { "content-encoding": "gzip" }).end(bomb) });
    expect(await code(fetchStructure("pdb:1ABC", opts(s, { maxBytes: 100_000 })))).toBe("FETCH_TOO_LARGE");
    nothing("pdb", "1ABC");
  });

  it.each([
    ["an HTML page", "/download/1ABC.cif", "<html><body>Error</body></html>"],
    ["an mmCIF for another entry", "/download/1ABC.cif", CIF("9XYZ")],
    ["an mmCIF without atoms", "/download/1ABC.cif", "data_1ABC\n_entry.id 1ABC\n"],
    ["an empty body", "/download/1ABC.cif", ""],
    ["a binary body", "/download/1ABC.cif", "data_1ABC\n\u0000\u0001_atom_site.id\n"],
    ["a PDB file without atoms", "/download/1ABC.pdb", "HEADER only\n"],
  ])("%s", async (_name, route, body) => {
    const s = await mock({ [route]: body });
    const format = route.endsWith(".pdb") ? "pdb" : undefined;
    expect(await code(fetchStructure("pdb:1ABC", opts(s, { format })))).toBe("FETCH_BAD_CONTENT");
    nothing("pdb", "1ABC");
  });

  it.each([
    ["two records", `${FASTA}${FASTA}`],
    ["no header", "MRPSGTAG\n"],
    ["digits in the sequence", ">x\nMRP123\n"],
  ])("a FASTA with %s", async (_name, body) => {
    const s = await mock({ "/uniprotkb/P00533.fasta": body });
    expect(await code(fetchStructure("uniprot:P00533", opts(s)))).toBe("FETCH_BAD_CONTENT");
    nothing("uniprot", "P00533");
  });

  it("a redirect to another host, which is never contacted", async () => {
    const other = await mock({ "/download/1ABC.cif": CIF("1ABC") });
    const s = await mock({ "/download/1ABC.cif": (_r, res) => void res.writeHead(302, { location: `http://${other.host}/download/1ABC.cif` }).end() });
    expect(await code(fetchStructure("pdb:1ABC", opts(s)))).toBe("FETCH_REDIRECT_REFUSED");
    expect(other.requests).toHaveLength(0);
    nothing("pdb", "1ABC");
  });

  it("a redirect to a different scheme or an endless redirect loop", async () => {
    const s = await mock({
      "/download/1ABC.cif": (_r, res) => void res.writeHead(302, { location: "https://127.0.0.1/x" }).end(),
      "/download/2ABC.cif": (_r, res) => void res.writeHead(302, { location: "/download/2ABC.cif" }).end(),
    });
    expect(await code(fetchStructure("pdb:1ABC", opts(s)))).toBe("FETCH_REDIRECT_REFUSED");
    expect(await code(fetchStructure("pdb:2ABC", opts(s)))).toBe("FETCH_REDIRECT_REFUSED");
    nothing("pdb", "1ABC");
    nothing("pdb", "2ABC");
  });

  it("a timeout", async () => {
    const s = await mock({ "/download/1ABC.cif": () => undefined });
    expect(await code(fetchStructure("pdb:1ABC", opts(s, { timeoutMs: 100 })))).toBe("FETCH_TIMEOUT");
  });

  it("a cancellation", async () => {
    const s = await mock({ "/download/1ABC.cif": () => undefined });
    const controller = new AbortController();
    const pending = code(fetchStructure("pdb:1ABC", opts(s, { signal: controller.signal })));
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toBe("FETCH_CANCELLED");
  });

  it("an unreachable server", async () => {
    const s = await mock({});
    await s.close();
    expect(await code(fetchStructure("pdb:1ABC", opts(s)))).toBe("FETCH_NETWORK_ERROR");
  });

  it("the real endpoints are https only (an http endpoint override is a test seam, not a CLI option)", async () => {
    let called = false;
    const fake = (async () => { called = true; return new Response("x"); }) as typeof fetch;
    await code(fetchStructure("pdb:1ABC", { paths: paths(), fetch: fake, endpoints: { pdb: { host: "files.rcsb.org", scheme: "https" } } }));
    expect(called).toBe(true); // it did try the allowed host
    const cross = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } })) as typeof fetch;
    expect(await code(fetchStructure("pdb:1ABC", { paths: paths(), fetch: cross }))).toBe("FETCH_REDIRECT_REFUSED");
  });
});

describe("AlphaFold DB answers are untrusted", () => {
  const route = (api: string) => ({ "/api/prediction/P00533": api, "/files/AF-P00533-F1-model_v6.cif": CIF("AF-P00533-F1") });
  it.each([
    ["a file URL on another host", AF_API({ cifUrl: "https://evil.example/files/AF-P00533-F1-model_v6.cif" })],
    ["a file URL over http", AF_API({ cifUrl: "http://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.cif" })],
    ["a traversing path", AF_API({ cifUrl: "https://alphafold.ebi.ac.uk/files/../../etc/passwd" })],
    ["a path for another accession", AF_API({ cifUrl: "https://alphafold.ebi.ac.uk/files/AF-Q9Y6K9-F1-model_v6.cif" })],
    ["a missing URL", AF_API({ cifUrl: undefined })],
    ["credentials in the URL", AF_API({ cifUrl: "https://user:pw@alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.cif" })],
    ["no matching entry", JSON.stringify([{ entryId: "AF-P00533-4-F1" }])],
    ["an empty list", "[]"],
    ["an object instead of a list", "{}"],
    ["not JSON", "<html>"],
  ])("rejects %s", async (_name, api) => {
    const s = await mock(route(api));
    expect(await code(fetchStructure("afdb:P00533", opts(s)))).toMatch(/^FETCH_BAD_CONTENT$/);
    expect(cacheFiles("afdb", "P00533")).toEqual([]);
    expect(s.requests.map((r) => r.url)).toEqual(["/api/prediction/P00533"]); // the bad URL was never requested
  });

  it("reports an unknown accession as not found", async () => {
    const s = await mock({});
    expect(await code(fetchStructure("afdb:P00533", opts(s)))).toBe("FETCH_NOT_FOUND");
  });
});

describe("the cache", () => {
  const routes = () => ({ "/download/1M17.cif": CIF("1M17") });

  it("answers a repeat from the cache without any request", async () => {
    const s = await mock(routes());
    await fetchStructure("pdb:1M17", opts(s));
    expect(s.requests).toHaveLength(1);
    const again = await fetchStructure("pdb:1M17", opts(s));
    expect(again.result.fromCache).toBe(true);
    expect(s.requests).toHaveLength(1);
    await s.close();
    expect((await fetchStructure("pdb:1M17", opts(s))).result.fromCache).toBe(true); // works offline
  });

  it("--refresh downloads again, and a failed refresh keeps the cached copy", async () => {
    let body = CIF("1M17");
    const s = await mock({ "/download/1M17.cif": (_r, res) => void res.writeHead(body ? 200 : 500).end(body || "boom") });
    const first = await fetchStructure("pdb:1M17", opts(s));
    const again = await fetchStructure("pdb:1M17", opts(s, { refresh: true }));
    expect(s.requests).toHaveLength(2);
    expect(again.result.fromCache).toBe(false);
    expect(again.result.provenance.sha256).toBe(first.result.provenance.sha256);
    body = "";
    expect(await code(fetchStructure("pdb:1M17", opts(s, { refresh: true })))).toBe("FETCH_HTTP_ERROR");
    expect(fs.readFileSync(first.result.files[0].path, "utf8")).toBe(CIF("1M17"));
    expect(cacheFiles("pdb", "1M17")).toEqual(["1M17.cif", "1M17.cif.provenance.json"]);
  });

  it.each([
    ["a file edited after it was cached", (d: string) => fs.appendFileSync(path.join(d, "1M17.cif"), "# edited\n")],
    ["a missing sidecar", (d: string) => fs.rmSync(path.join(d, "1M17.cif.provenance.json"))],
    ["a corrupt sidecar", (d: string) => fs.writeFileSync(path.join(d, "1M17.cif.provenance.json"), "{")],
    ["a sidecar for another file", (d: string) => {
      const p = path.join(d, "1M17.cif.provenance.json");
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace('"1M17"', '"9XYZ"'));
    }],
  ])("does not trust %s and downloads again", async (_name, damage) => {
    const s = await mock(routes());
    const first = await fetchStructure("pdb:1M17", opts(s));
    damage(path.dirname(first.result.files[0].path));
    const again = await fetchStructure("pdb:1M17", opts(s));
    expect(again.result.fromCache).toBe(false);
    expect(s.requests).toHaveLength(2);
    expect(fs.readFileSync(first.result.files[0].path, "utf8")).toBe(CIF("1M17"));
  });

  it("keeps formats side by side", async () => {
    const s = await mock({ "/download/1M17.cif": CIF("1M17"), "/download/1M17.pdb": PDB });
    await fetchStructure("pdb:1M17", opts(s));
    await fetchStructure("pdb:1M17", opts(s, { format: "pdb" }));
    expect(cacheFiles("pdb", "1M17")).toEqual(["1M17.cif", "1M17.cif.provenance.json", "1M17.pdb", "1M17.pdb.provenance.json"]);
  });
});

describe("--output", () => {
  it("copies the file and its provenance, from the cache when it is already there", async () => {
    const s = await mock({ "/download/1M17.cif": CIF("1M17") });
    const out = path.join(dir, "out", "nested");
    const result = (await fetchStructure("pdb:1M17", opts(s, { outputDir: out }))).result;
    expect(result.files[0].path).toBe(path.join(out, "1M17.cif"));
    expect(fs.readdirSync(out).sort()).toEqual(["1M17.cif", "1M17.cif.provenance.json"]);
    expect(fs.readFileSync(path.join(out, "1M17.cif"), "utf8")).toBe(CIF("1M17"));
    const out2 = path.join(dir, "out2");
    const second = (await fetchStructure("pdb:1M17", opts(s, { outputDir: out2 }))).result;
    expect(second.fromCache).toBe(true);
    expect(s.requests).toHaveLength(1);
    expect(second.cacheDir).toBe(path.join(paths().cache, "fetch", "pdb", "1M17"));
  });

  it("never overwrites an existing file", async () => {
    const s = await mock({ "/download/1M17.cif": CIF("1M17") });
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "1M17.cif"), "mine");
    expect(await code(fetchStructure("pdb:1M17", opts(s, { outputDir: out })))).toBe("OUTPUT_EXISTS");
    expect(fs.readFileSync(path.join(out, "1M17.cif"), "utf8")).toBe("mine");
    expect(fs.readdirSync(out)).toEqual(["1M17.cif"]);
  });
});

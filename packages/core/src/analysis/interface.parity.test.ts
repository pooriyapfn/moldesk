// Opt-in, offline CPU parity: provide existing Python+NumPy and the audited pinned source.
// A genuine Boltz fixture can additionally be supplied with its provenance and original run.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getMoldeskPaths, runCommand } from "@moldesk/runtime";
import { IPSAE_RESOURCES, IPSAE_REVISION, IPSAE_SOURCE } from "../tools/ipsae.js";
import { sha256File } from "../hash.js";
import { scoreProteinInterface } from "./interface.js";
import { parseIpsaeOutput } from "./ipsae-output.js";
import { resolveBoltzPredictionArtifacts } from "./boltz-artifacts.js";
import { boltzRecord } from "../testSupport/interface.js";
const python = process.env.MOLDESK_TEST_IPSAE_PYTHON;
const source = process.env.MOLDESK_TEST_IPSAE_SOURCE;
let root: string, tool: string;
vi.mock("../tools/ipsae.js", async (original) => ({ ...await original<typeof import("../tools/ipsae.js")>(),
  requireIpsae: vi.fn(async () => ({ dir: tool, executable: python, receipt: { revision: IPSAE_REVISION, sourceSha256: IPSAE_SOURCE.sha256 } })),
}));
describe.runIf(!!python && !!source)("pinned upstream parity on CPU", () => {
  beforeAll(async () => {
    expect(await sha256File(source!)).toBe(IPSAE_SOURCE.sha256);
    root = fs.mkdtempSync(path.join(os.tmpdir(),"moldesk-parity-")); tool = path.join(root,"tool"); fs.mkdirSync(tool);
    fs.copyFileSync(source!,path.join(tool,"ipsae.py")); fs.copyFileSync(path.join(IPSAE_RESOURCES,"validate.py"),path.join(tool,"validate.py"));
  });
  afterAll(()=>{if(root)fs.rmSync(root,{recursive:true,force:true});});
  async function parity(record: Awaited<ReturnType<typeof boltzRecord>>, target:string,binder:string) {
    const a = await resolveBoltzPredictionArtifacts(record);
    const raw = path.join(root,`raw-${Date.now()}`); fs.mkdirSync(raw);
    for (const f of [a.structure,a.pae!,a.confidence,a.plddt]) if(f) fs.copyFileSync(f.path,path.join(raw,path.basename(f.path)));
    const rawResult = await runCommand(python!,["-I","-B",path.join(tool,"ipsae.py"),path.basename(a.pae!.path),path.basename(a.structure.path),"15","15"],{cwd:raw,timeoutMs:120000,maxOutputBytes:1024**2});
    expect(rawResult.code,rawResult.stderr).toBe(0);
    const expected=parseIpsaeOutput(fs.readFileSync(path.join(raw,path.basename(a.structure.path,".cif")+"_15_15.txt"),"utf8"),target,binder,15,15);
    const actual=await scoreProteinInterface({structure:a.structure.path,pae:a.pae!.path,confidence:a.confidence.path,plddt:a.plddt?.path,targetChain:target,binderChain:binder,outputPath:path.join(raw,"wrapped.json"),paths:getMoldeskPaths({MOLDESK_HOME:root})});
    for (const key of ["ipsaeTargetToBinder","ipsaeBinderToTarget","ipsaeMax"] as const) expect(Math.abs(actual.result.scores[key]-expected[key])).toBeLessThanOrEqual(0.000002);
    return actual.result.scores;
  }
  it("preserves asymmetric directional scores on the bounded synthetic fixture",async()=>{
    const scores=await parity(await boltzRecord(path.join(root,"synthetic")),"A","B");
    expect(scores).toEqual({ipsaeTargetToBinder:.5,ipsaeBinderToTarget:.2,ipsaeMax:.5});
  });
  it.runIf(!!process.env.MOLDESK_BOLTZ_FIXTURE)("matches genuine Boltz data with recorded provenance",async()=>{
    const fixture=process.env.MOLDESK_BOLTZ_FIXTURE!;
    const provenance=JSON.parse(fs.readFileSync(path.join(fixture,"provenance.json"),"utf8"));
    for(const key of ["sourceLicense","job","seed","modelRevision"]) expect(provenance[key]).toBeDefined();
    const run=JSON.parse(fs.readFileSync(path.join(fixture,"run.json"),"utf8"));
    await parity(run,provenance.targetChain,provenance.binderChain);
  });
});

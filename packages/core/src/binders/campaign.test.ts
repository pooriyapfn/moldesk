import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { freezeBinderGeneration, freezeBinderTarget, prepareBinderPredictions, sequenceHash, type PreparedBinderCandidate } from "./prepare.js";
import { rankBinderCandidates, collectBinderPredictionSample, writeBinderCandidateTable, type BinderCampaignManifest, type BinderCandidateState } from "./campaign.js";
import { hashArtifact, resolveBoltzPredictionArtifacts } from "../analysis/boltz-artifacts.js";
import { digest } from "../hash.js";
import { proteinCif, boltzRecord } from "../testSupport/interface.js";
import type { RunRecord } from "../run.js";
const dirs: string[] = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-binder-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
async function fixture() {
  const root = tmp(), input = path.join(root, "target.cif"), spec = path.join(root, "spec.yaml");
  fs.writeFileSync(input, proteinCif()); fs.writeFileSync(spec, 'binder:\n  input: target.cif\n  contig: "2, /0, A1-2"\n');
  const sourceJob = await hashArtifact(spec), target = await freezeBinderTarget(input, "A", [1,2]);
  const outputs = [];
  for (const i of [0,1]) {
    const file = path.join(root, `binder_${i}_generated.cif`); fs.writeFileSync(file, proteinCif());
    outputs.push({ id: "generated_structures", ...await hashArtifact(file) });
  }
  const generation = { id: "source-run", model: "rfd4-proteina", status: "succeeded", input: [{ role: "job", storedPath: spec, sha256: sourceJob.sha256 }], outputs } as unknown as RunRecord;
  const roles = { binder: { targetChain: "A", binderChain: "B", expectedContig: "2, /0, A1-2", generatedTargetStart: 1 } };
  const approvedGeneration = await freezeBinderGeneration(spec);
  generation.input.push(...approvedGeneration.inputs.map((i) => ({ role: i.role, originalPath: i.artifact.path, storedPath: i.artifact.path, sha256: i.artifact.sha256 })));
  const options = { generation, approvedGeneration, roles, target, outputDir: path.join(root,"jobs") };
  const manifest: BinderCampaignManifest = { schemaVersion:1, policyRevision:"v1", createdAt:"2026-10-28T00:00:00Z", generation:approvedGeneration, target, roles, generationSeeds:[1,2],
    predictionProtocol: { modelVersion:"2.2.1", adapterVersion:"0.2.0", samples:1, parameters:{ write_full_pae:true, diffusion_samples:1 } },
    scoring:{ revision:"a".repeat(40), sourceSha256:"b".repeat(64), paeCutoffAngstrom:15, distanceCutoffAngstrom:15 },
    ranking:{ metric:"ipsaeMax", aggregation:"min", minimum:.6, shortlistSize:2, diversity:"exact-sequence" } };
  return { root, options, manifest };
}
it("prepares exact unique jobs, retains duplicate lineage, and verifies partial restart", async () => {
  const { options } = await fixture();
  options.generation.outputs.push({ ...options.generation.outputs[0], id:"input_structures" });
  const candidates = await prepareBinderPredictions(options);
  expect(candidates).toHaveLength(2); expect(candidates[1].duplicateOf).toBe(candidates[0].candidateId);
  const job = JSON.parse(fs.readFileSync(candidates[0].job!.path,"utf8"));
  expect(job.sequences.map((s: {protein: {msa:string}}) => s.protein.msa)).toEqual(["empty","empty"]);
  expect(await prepareBinderPredictions(options)).toEqual(candidates);
  fs.appendFileSync(candidates[0].mapping!.path, "changed");
  await expect(prepareBinderPredictions(options)).rejects.toMatchObject({ code:"INVALID_BINDER_CAMPAIGN" });
});
it("rejects changed target, changed source output and incorrect explicit roles", async () => {
  const { options } = await fixture();
  await expect(prepareBinderPredictions({ ...options, target: { ...options.target, sequence:"GG" } })).rejects.toMatchObject({ code:"INVALID_BINDER_CAMPAIGN" });
  await expect(prepareBinderPredictions({ ...options, roles: { binder:{...options.roles.binder,targetChain:"missing"} } })).rejects.toMatchObject({ code:"INVALID_BINDER_CAMPAIGN" });
  fs.appendFileSync(options.generation.outputs[0].path,"changed");
  await expect(prepareBinderPredictions(options)).rejects.toMatchObject({ code:"BOLTZ_ARTIFACT_MISMATCH" });
});
it("rejects a generation that changes the preregistered spec or companion bytes", async () => {
  const { root, options } = await fixture();
  const changedSpec = path.join(root, "other.yaml");
  fs.writeFileSync(changedSpec, fs.readFileSync(options.approvedGeneration.spec.path, "utf8") + "\n# changed approved spec\n");
  const job = await hashArtifact(changedSpec), run = structuredClone(options.generation);
  run.input[0] = { ...run.input[0], storedPath: changedSpec, sha256: job.sha256 };
  await expect(prepareBinderPredictions({ ...options, generation: run })).rejects.toMatchObject({ code: "INVALID_BINDER_CAMPAIGN" });
  const changedTarget = path.join(root, "other.cif"); fs.writeFileSync(changedTarget, proteinCif() + "# changed companion\n");
  const input = await hashArtifact(changedTarget), other = structuredClone(options.generation);
  other.input[1] = { ...other.input[1], storedPath: changedTarget, sha256: input.sha256 };
  await expect(prepareBinderPredictions({ ...options, generation: other })).rejects.toMatchObject({ code: "INVALID_BINDER_CAMPAIGN" });
});
async function scoredStates() {
  const { options, manifest } = await fixture();
  const [candidate] = await prepareBinderPredictions(options);
  const prediction = await boltzRecord(tmp());
  prediction.input = [{ role:"job", originalPath:candidate.job!.path, storedPath:candidate.job!.path, sha256:candidate.job!.sha256 }];
  const sample = await collectBinderPredictionSample(manifest,candidate,prediction,{});
  const make = (id:string, seq:string, metric:number): BinderCandidateState => {
    const c:PreparedBinderCandidate = { ...candidate, candidateId:id, binderSequence:seq, binderSha256:sequenceHash(seq) };
    const result = { inputs:{structure:sample.artifacts.structure,pae:sample.artifacts.pae!,confidence:sample.artifacts.confidence}, chains:{target:{authId:"A",labelId:"A"},binder:{authId:"B",labelId:"B"}},
      settings:{paeCutoffAngstrom:15,distanceCutoffAngstrom:15},tokenMapping:{mode:"boltz-two-protein-chains" as const,count:4,sha256:"c".repeat(64)},
      scores:{ipsaeTargetToBinder:metric,ipsaeBinderToTarget:metric,ipsaeMax:metric}, scorer:{name:"ipsae" as const,revision:manifest.scoring.revision,sourceSha256:manifest.scoring.sourceSha256},artifacts:[] };
    return { candidate:c,samples:[{...sample,evaluation:{file:candidate.job!,result}}],failures:[],reports:[] };
  };
  return { manifest, states:[make("b","AA",.8),make("a","CC",.8),make("c","DD",.1)], candidate, prediction };
}
it("ranks deterministic ties, keeps failed/null and duplicate rows, and writes JSON/CSV", async () => {
  const { manifest, states } = await scoredStates();
  states.push({ ...states[0],candidate:{...states[0].candidate,candidateId:"duplicate",duplicateOf:"b"},samples:[] });
  states.push({ ...states[2],candidate:{...states[2].candidate,candidateId:"failed",binderSequence:"EE",binderSha256:sequenceHash("EE")},samples:[],failures:[{phase:"prediction",reason:"oom"}] });
  const table = await writeBinderCandidateTable(tmp(),manifest,states);
  expect(table.counts).toEqual({generated:5,unique:4,predicted:3,scored:3,shortlisted:2});
  expect(table.rows.find((r) => r.candidate.candidateId === "a")!.rank).toBe(1);
  expect(table.rows.find((r) => r.candidate.candidateId === "failed")).toMatchObject({metric:null,status:"failed",reasons:expect.arrayContaining(["prediction: oom"])});
  expect(table.rows.find((r) => r.candidate.candidateId === "duplicate")!.status).toBe("duplicate");
  const zero = rankBinderCandidates({...manifest,ranking:{...manifest.ranking,minimum:.99}},states); expect(zero.counts.shortlisted).toBe(0);
});
it("requires every sample; rejects incompatible protocols/scorers and undeclared duplicates", async () => {
  const { manifest, states } = await scoredStates();
  const multi = {...manifest,predictionProtocol:{...manifest.predictionProtocol,samples:2,parameters:{write_full_pae:true,diffusion_samples:2}}};
  const state = structuredClone(states[0]); state.samples[0].protocolSha256=digest(multi.predictionProtocol);
  expect(rankBinderCandidates(multi,[state]).rows[0].metric).toBeNull();
  state.samples[0].evaluation!.result.scorer.revision="d".repeat(40);
  expect(() => rankBinderCandidates(multi,[state])).toThrow();
  expect(() => rankBinderCandidates(manifest,[states[0],{...states[0],candidate:{...states[0].candidate,candidateId:"copy"}}])).toThrow();
  const changed=structuredClone(states); changed[0].samples[0].protocolSha256="0".repeat(64); expect(()=>rankBinderCandidates(manifest,changed)).toThrow();
});
it("matches effective parameters regardless of object key order and refuses a different job", async () => {
  const {manifest,candidate,prediction}=await scoredStates();
  prediction.parameters.effective={diffusion_samples:1,write_full_pae:true};
  await expect(collectBinderPredictionSample(manifest,candidate,prediction,{})).resolves.toHaveProperty("predictionRunId");
  await expect(collectBinderPredictionSample(manifest,{...candidate,binderSequence:"CC",binderSha256:sequenceHash("CC")},prediction,{})).rejects.toMatchObject({code:"INVALID_BINDER_CAMPAIGN"});
  prediction.input[0].sha256="0".repeat(64);
  await expect(collectBinderPredictionSample(manifest,candidate,prediction,{})).rejects.toMatchObject({code:"INVALID_BINDER_CAMPAIGN"});
});

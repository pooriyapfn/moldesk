#!/usr/bin/env node
// Local evidence bookkeeping only. Paid inference remains an explicit moldesk run command.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  freezeBinderGeneration, freezeBinderTarget, prepareBinderPredictions, collectBinderPredictionSample, rankBinderCandidates,
  validateBinderCampaign, writeBinderCandidateTable, scoreProteinInterface, verifyArtifact, hashArtifact,
  IPSAE_REVISION, IPSAE_SOURCE,
} from "../../packages/core/dist/index.js";

const [action, rootArg, ...args] = process.argv.slice(2);
if (!rootArg) throw new Error("Usage: run.mjs init|prepare|prediction|score|table|decision <campaign-dir> [arguments]");
const root = path.resolve(rootArg);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const atomic = (name, value) => {
  const file = path.join(root, name), temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, file);
};
const decision = (entry) => fs.appendFileSync(path.join(root, "decisions.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
let manifest, states;
if (action === "init") {
  const config = read(args[0]);
  const ids = Array.from({ length: config.target.end - config.target.start + 1 }, (_, i) => config.target.start + i);
  const target = await freezeBinderTarget(path.resolve(args[1]), config.target.chain, ids);
  if (target.sequence !== config.target.sequence) throw new Error("Target differs from the approved PD-L1 sequence.");
  const generation = await freezeBinderGeneration(path.resolve(path.dirname(args[0]), config.generationSpec));
  manifest = { generation, schemaVersion: 1, policyRevision: config.policyRevision, createdAt: new Date().toISOString(), target,
    roles: config.roles, generationSeeds: config.generationSeeds, predictionProtocol: config.predictionProtocol,
    scoring: { ...config.scoring, revision: IPSAE_REVISION, sourceSha256: IPSAE_SOURCE.sha256 }, ranking: config.ranking };
  validateBinderCampaign(manifest);
  fs.mkdirSync(root, { mode: 0o700 }); // refuses an existing campaign
  atomic("campaign.json", manifest); atomic("state.json", []);
  atomic("measurements.json", { costs: [], timings: [], failures: [], transfers: [], actualCharges: null, agentApiCost: null });
  decision({ action: "init", manifestSha256: hash(manifest), config: await hashArtifact(args[0]) });
} else {
  manifest = read(path.join(root, "campaign.json")); validateBinderCampaign(manifest);
  const events = fs.readFileSync(path.join(root, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  if (events[0]?.manifestSha256 !== hash(manifest)) throw new Error("Campaign policy changed; create a new policy revision/campaign.");
  const runs = new Map();
  for (const event of events) if (event.run) { await verifyArtifact(event.run); const run = read(event.run.path); runs.set(run.id, run); }
  states = read(path.join(root, "state.json"));
  await verifyArtifact(manifest.target.structure);
  await verifyArtifact(manifest.generation.spec);
  for (const input of manifest.generation.inputs) await verifyArtifact(input.artifact);
  // A file's existence never establishes completion: verify retained scientific inputs and results.
  for (const state of states) {
    for (const file of [state.candidate.source, state.candidate.sourceJob, state.candidate.job, state.candidate.mapping]) if (file) await verifyArtifact(file);
    for (const sample of state.samples) {
      const prediction = runs.get(sample.predictionRunId);
      if (!prediction) throw new Error("Prediction run evidence missing from decision log.");
      const checked = await collectBinderPredictionSample(manifest, state.candidate, prediction, { recordId: sample.artifacts.recordId, predictionRank: sample.artifacts.predictionRank }, sample.evaluation?.file.path);
      if (hash(checked.artifacts) !== hash(sample.artifacts)) throw new Error("Prediction evidence changed.");
      for (const file of [sample.artifacts.structure, sample.artifacts.confidence, sample.artifacts.pae, sample.artifacts.plddt]) if (file) await verifyArtifact(file);
      if (sample.evaluation) {
        await verifyArtifact(sample.evaluation.file);
        if (hash(read(sample.evaluation.file.path).result) !== hash(sample.evaluation.result)) throw new Error("Retained evaluation metadata changed.");
        for (const file of sample.evaluation.result.artifacts) await verifyArtifact(file);
      }
    }
  }
  rankBinderCandidates(manifest, states);
  if (action === "prepare") {
    const generation = read(args[0]);
    if (Date.parse(generation.startedAt) < Date.parse(manifest.createdAt) || !manifest.generationSeeds.includes(generation.parameters.effective.seed)) throw new Error("Generation must follow policy registration and use a declared seed.");
    const existing = states.filter((s) => s.candidate.sourceRunId === generation.id);
    const candidates = await prepareBinderPredictions({ generation, approvedGeneration: manifest.generation, target: manifest.target, roles: manifest.roles, outputDir: path.join(root, "jobs"), previous: states.filter((s) => s.candidate.sourceRunId !== generation.id).map((s) => s.candidate) });
    if (existing.length) {
      if (hash(existing.map((s) => s.candidate)) !== hash(candidates)) throw new Error("Prepared generation changed on restart.");
    } else states.push(...candidates.map((candidate) => ({ candidate, samples: [], failures: [], reports: generation.artifacts?.filter((a) => a.kind === "molecular-report").map((a) => a.path) ?? [] })));
    decision({ action, run: await hashArtifact(args[0]), durationMs: generation.durationMs, compute: generation.compute });
  } else if (action === "prediction") {
    const state = states.find((s) => s.candidate.candidateId === args[0]);
    if (!state) throw new Error("Unknown candidate ID.");
    const run = read(args[1]);
    if (run.status !== "succeeded") {
      if (run.input[0]?.sha256 !== state.candidate.job?.sha256) throw new Error("Failed run belongs to another input.");
      if (!state.failures.some((f) => f.runId === run.id)) state.failures.push({ phase: "prediction", runId: run.id, reason: run.error?.message ?? run.status });
    } else {
      const structures = run.outputs.filter((o) => o.id === "structures");
      if (structures.length !== manifest.predictionProtocol.samples) throw new Error("Prediction sample count differs from policy.");
      for (const structure of structures) {
        const match = /^(.*)_model_(\d+)\.cif$/.exec(path.basename(structure.path));
        if (!match) throw new Error("Invalid Boltz filename.");
        const sample = await collectBinderPredictionSample(manifest, state.candidate, run, { recordId: match[1], predictionRank: Number(match[2]) });
        const old = state.samples.find((s) => s.artifacts.recordId === sample.artifacts.recordId && s.artifacts.predictionRank === sample.artifacts.predictionRank);
        if (old && hash(old.artifacts) !== hash(sample.artifacts)) throw new Error("Prediction changed; retain retries as a separate protocol decision.");
        if (!old) state.samples.push(sample);
      }
    }
    for (const report of run.artifacts ?? []) if (report.kind === "molecular-report" && !state.reports.includes(report.path)) state.reports.push(report.path);
    decision({ action, candidateId: args[0], run: await hashArtifact(args[1]), durationMs: run.durationMs, compute: run.compute });
  } else if (action === "score") {
    fs.mkdirSync(path.join(root, "scores"), { recursive: true });
    for (const state of states) for (const sample of state.samples) {
      if (sample.evaluation || sample.failure) continue;
      const a = sample.artifacts;
      const outputPath = path.join(root, "scores", `${state.candidate.candidateId}-${a.predictionRank}.json`);
      try {
        let envelope;
        if (fs.existsSync(outputPath)) {
          envelope = read(outputPath);
          if (envelope.kind !== "moldesk.interface" || envelope.status !== "ok") throw new Error("Invalid retained score envelope.");
          for (const [key, value] of Object.entries(envelope.result.inputs)) {
            await verifyArtifact(value);
            if (value.sha256 !== a[key]?.sha256) throw new Error("Retained score input differs from prediction.");
          }
          for (const file of envelope.result.artifacts) await verifyArtifact(file);
        } else envelope = await scoreProteinInterface({ structure: a.structure.path, pae: a.pae?.path, confidence: a.confidence.path, plddt: a.plddt?.path,
          runRecord: runs.get(sample.predictionRunId), targetChain: "A", binderChain: "B", paeCutoffAngstrom: manifest.scoring.paeCutoffAngstrom, distanceCutoffAngstrom: manifest.scoring.distanceCutoffAngstrom, outputPath });
        sample.evaluation = { file: await hashArtifact(outputPath), result: envelope.result };
        rankBinderCandidates(manifest, states); // validates scorer, cutoffs and roles before persisting
      } catch (error) {
        sample.failure = `${error.code ?? "ERROR"}: ${error.message}`;
        decision({ action: "score-failed", candidateId: state.candidate.candidateId, reason: sample.failure });
      }
      atomic("state.json", states); // checkpoint each sample, failures included
    }
  } else if (action === "table") {
    const directory = path.join(root, "snapshots", randomUUID());
    await writeBinderCandidateTable(directory, manifest, states);
    for (const name of ["candidates.json", "candidates.csv", "index.md"]) {
      const temp = path.join(root, `${name}.${randomUUID()}.tmp`);
      fs.copyFileSync(path.join(directory, name), temp); fs.renameSync(temp, path.join(root, name));
    }
    decision({ action, snapshot: directory });
  } else if (action === "decision") {
    if (!args.join(" ").trim()) throw new Error("Record an explicit agent/user decision and its evidence.");
    decision({ action, message: args.join(" ") });
  } else throw new Error(`Unknown action: ${action}`);
  rankBinderCandidates(manifest, states); atomic("state.json", states);
}

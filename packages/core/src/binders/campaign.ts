import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { writeFileExclusive } from "@moldesk/visualizer";
import { digest } from "../hash.js";
import { verifyArtifact, hashArtifact, resolveBoltzPredictionArtifacts, type HashedFile, type BoltzPredictionArtifacts } from "../analysis/boltz-artifacts.js";
import type { InterfaceScoreResult } from "../analysis/interface.js";
import { validateEnvelope } from "../schemas/envelope.js";
import type { RunRecord } from "../run.js";
import { binderError, sequenceHash, type PreparedBinderCandidate, type FrozenBinderTarget, type FrozenBinderGeneration, type BinderRoles } from "./prepare.js";

export interface BinderCampaignManifest {
  schemaVersion: 1; policyRevision: string; createdAt: string;
  generation: FrozenBinderGeneration; target: FrozenBinderTarget; roles: Record<string, BinderRoles>;
  generationSeeds: number[];
  predictionProtocol: { modelVersion: string; adapterVersion: string; parameters: Record<string, unknown>; samples: number };
  scoring: { revision: string; sourceSha256: string; paeCutoffAngstrom: number; distanceCutoffAngstrom: number };
  ranking: { metric: "ipsaeMax"; aggregation: "mean" | "min"; minimum: number; shortlistSize: number; diversity: "exact-sequence" };
}
export interface BinderPredictionSample {
  predictionRunId: string; protocolSha256: string; artifacts: BoltzPredictionArtifacts;
  evaluation?: { file: HashedFile; result: InterfaceScoreResult };
  failure?: string;
}
export interface BinderCandidateState {
  candidate: PreparedBinderCandidate; samples: BinderPredictionSample[];
  failures: Array<{ phase: "prediction" | "scoring"; reason: string; runId?: string }>;
  reports: string[];
}
export interface BinderCandidateRow extends BinderCandidateState {
  status: "duplicate" | "generated" | "predicted" | "failed" | "rejected" | "shortlisted";
  metric: number | null; rank: number | null; reasons: string[];
}
export function validateBinderCampaign(m: BinderCampaignManifest): void {
  if (m.schemaVersion !== 1 || !/^[0-9a-f]{64}$/.test(m.generation.spec.sha256) || !m.policyRevision || !m.createdAt || !/^[0-9a-f]{64}$/.test(m.target.sha256) ||
      !m.generationSeeds.length || m.generationSeeds.some((s) => !Number.isSafeInteger(s) || s < 0) || new Set(m.generationSeeds).size !== m.generationSeeds.length ||
      !Number.isInteger(m.predictionProtocol.samples) || m.predictionProtocol.samples < 1 || !m.predictionProtocol.modelVersion || !m.predictionProtocol.adapterVersion ||
      m.predictionProtocol.parameters.write_full_pae !== true || m.predictionProtocol.parameters.diffusion_samples !== m.predictionProtocol.samples ||
      !/^[0-9a-f]{40}$/.test(m.scoring.revision) || !/^[0-9a-f]{64}$/.test(m.scoring.sourceSha256) ||
      ![m.scoring.paeCutoffAngstrom, m.scoring.distanceCutoffAngstrom].every((x) => Number.isSafeInteger(x) && x > 0) ||
      m.ranking.metric !== "ipsaeMax" || !["mean", "min"].includes(m.ranking.aggregation) || m.ranking.diversity !== "exact-sequence" ||
      !Number.isFinite(m.ranking.minimum) || m.ranking.minimum < 0 || m.ranking.minimum > 1 || !Number.isSafeInteger(m.ranking.shortlistSize) || m.ranking.shortlistSize < 0) binderError("Invalid campaign manifest/policy.");
}

/** Connect a run and optional score file through exact job, protocol and artifact identities. */
export async function collectBinderPredictionSample(manifest: BinderCampaignManifest, candidate: PreparedBinderCandidate, prediction: RunRecord,
  selector: { recordId?: string; predictionRank?: number }, evaluationPath?: string): Promise<BinderPredictionSample> {
  validateBinderCampaign(manifest);
  if (!candidate.job || candidate.targetSha256 !== manifest.target.sha256 || candidate.duplicateOf) binderError("Candidate has no unique prediction input for this target.");
  await verifyArtifact(candidate.job);
  let job;
  try { job = JSON.parse(fs.readFileSync(candidate.job.path, "utf8")); } catch { binderError("Expected an unchanged helper-prepared prediction job."); }
  if (job.sequences?.length !== 2 || job.sequences[0]?.protein?.id !== "A" || job.sequences[0]?.protein?.sequence !== manifest.target.sequence || job.sequences[1]?.protein?.id !== "B" || job.sequences[1]?.protein?.sequence !== candidate.binderSequence || sequenceHash(candidate.binderSequence) !== candidate.binderSha256) binderError("Prediction sequences/roles differ from the candidate.");
  const jobs = prediction.input.filter((i) => i.role === "job" || i.role === undefined);
  if (jobs.length !== 1 || jobs[0].sha256 !== candidate.job.sha256 || prediction.modelVersion !== manifest.predictionProtocol.modelVersion || prediction.adapterVersion !== manifest.predictionProtocol.adapterVersion || !isDeepStrictEqual(prediction.parameters.effective, manifest.predictionProtocol.parameters)) binderError("Prediction job/protocol differs from the preregistered campaign.");
  if ((await hashArtifact(jobs[0].storedPath)).sha256 !== jobs[0].sha256) binderError("Stored prediction job changed.");
  const artifacts = await resolveBoltzPredictionArtifacts(prediction, selector);
  const sample: BinderPredictionSample = { predictionRunId: prediction.id, protocolSha256: digest(manifest.predictionProtocol), artifacts };
  if (!evaluationPath) return sample;
  const file = await hashArtifact(evaluationPath, 4 * 1024 ** 2);
  const envelope = validateEnvelope(JSON.parse(fs.readFileSync(file.path, "utf8")), "moldesk.interface");
  const r = envelope.result as unknown as InterfaceScoreResult;
  for (const [key, expected] of Object.entries({ structure: artifacts.structure, pae: artifacts.pae, confidence: artifacts.confidence, plddt: artifacts.plddt })) {
    const actual = r.inputs[key as keyof typeof r.inputs];
    if (key === "plddt" && actual === undefined) continue;
    if (!expected || !actual || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) binderError(`Evaluation ${key} differs from its prediction.`);
    await verifyArtifact(actual);
  }
  for (const artifact of r.artifacts) await verifyArtifact(artifact);
  sample.evaluation = { file, result: r };
  return sample;
}

/** Pure ranking: all samples required; failures and duplicate rows remain visible. */
export function rankBinderCandidates(manifest: BinderCampaignManifest, states: BinderCandidateState[]) {
  validateBinderCampaign(manifest);
  const ids = new Set(states.map((s) => s.candidate.candidateId));
  if (ids.size !== states.length) binderError("Duplicate candidate IDs in table.");
  const sequences = new Set<string>();
  for (const { candidate } of states) if (!candidate.duplicateOf) {
    if (sequences.has(candidate.binderSha256)) binderError("Duplicate sequences must retain their parent links.");
    sequences.add(candidate.binderSha256);
  }
  const rows: BinderCandidateRow[] = states.map((state) => {
    const c = state.candidate;
    if (c.sourceJob.sha256 !== manifest.generation.spec.sha256 || c.targetSha256 !== manifest.target.sha256 || sequenceHash(c.binderSequence) !== c.binderSha256) binderError("Candidate target/sequence identity differs.");
    if (c.duplicateOf && (!ids.has(c.duplicateOf) || states.find((s) => s.candidate.candidateId === c.duplicateOf)?.candidate.binderSha256 !== c.binderSha256 || states.find((s) => s.candidate.candidateId === c.duplicateOf)?.candidate.duplicateOf)) binderError("Invalid duplicate parent.");
    const reasons = state.failures.map((f) => `${f.phase}: ${f.reason}`);
    if (state.samples.length > manifest.predictionProtocol.samples) binderError("Too many prediction samples for the policy.");
    if (new Set(state.samples.map((s) => `${s.predictionRunId}:${s.artifacts.recordId}`)).size > 1) binderError("Prediction samples must belong to one run and record.");
    const sampleIds = new Set<string>();
    for (const sample of state.samples) {
      const key = `${sample.artifacts.recordId}:${sample.artifacts.predictionRank}`;
      if (!Number.isInteger(sample.artifacts.predictionRank) || sample.artifacts.predictionRank < 0 || sample.artifacts.predictionRank >= manifest.predictionProtocol.samples || sampleIds.has(key) || sample.protocolSha256 !== digest(manifest.predictionProtocol)) binderError("Duplicate/incompatible prediction samples.");
      sampleIds.add(key);
      if (sample.failure) reasons.push(`scoring: ${sample.failure}`);
      const r = sample.evaluation?.result;
      if (r) for (const key of ["structure", "confidence", "pae"] as const) {
        if (!sample.artifacts[key] || r.inputs[key].sha256 !== sample.artifacts[key]!.sha256) binderError("Evaluation artifact differs from its prediction sample.");
      }
      if (r && (r.scorer.name !== "ipsae" || r.scorer.revision !== manifest.scoring.revision || r.scorer.sourceSha256 !== manifest.scoring.sourceSha256 ||
          r.settings.paeCutoffAngstrom !== manifest.scoring.paeCutoffAngstrom || r.settings.distanceCutoffAngstrom !== manifest.scoring.distanceCutoffAngstrom ||
          r.chains.target.authId !== "A" || r.chains.binder.authId !== "B" || Object.values(r.scores).length !== 3 || Object.values(r.scores).some((v) => !Number.isFinite(v) || v < 0 || v > 1) || Math.abs(r.scores.ipsaeMax - Math.max(r.scores.ipsaeTargetToBinder, r.scores.ipsaeBinderToTarget)) > 0.000002)) binderError("Incompatible interface evaluations cannot be ranked together.");
    }
    let metric: number | null = null;
    let status: BinderCandidateRow["status"] = c.duplicateOf ? "duplicate" : state.failures.length ? "failed" : state.samples.length ? "predicted" : "generated";
    if (c.duplicateOf) reasons.push(`exact sequence duplicate of ${c.duplicateOf}`);
    else if (state.samples.length === manifest.predictionProtocol.samples && state.samples.every((s) => s.evaluation && !s.failure) && !state.failures.length) {
      const values = state.samples.map((s) => s.evaluation!.result.scores.ipsaeMax);
      metric = manifest.ranking.aggregation === "min" ? Math.min(...values) : values.reduce((a, b) => a + b, 0) / values.length;
      status = "rejected";
      if (metric < manifest.ranking.minimum) reasons.push(`ipsaeMax ${manifest.ranking.aggregation} below ${manifest.ranking.minimum}`);
    } else if (!c.duplicateOf) {
      reasons.push("all preregistered prediction samples and evaluations are required");
      if (state.samples.some((s) => s.failure)) status = "failed";
    }
    return { ...state, status, metric, rank: null, reasons };
  });
  const ordered = rows.filter((r) => r.metric !== null).sort((a, b) => b.metric! - a.metric! || a.candidate.candidateId.localeCompare(b.candidate.candidateId));
  let shortlisted = 0;
  ordered.forEach((row, i) => {
    row.rank = i + 1;
    if (row.metric! >= manifest.ranking.minimum) {
      if (shortlisted < manifest.ranking.shortlistSize) { row.status = "shortlisted"; shortlisted++; }
      else row.reasons.push("outside shortlist size limit");
    }
  });
  return { schemaVersion: 1 as const, policySha256: digest(manifest), counts: { generated: rows.length, unique: rows.filter((r) => !r.candidate.duplicateOf).length,
    predicted: rows.filter((r) => r.samples.length > 0).length, scored: rows.filter((r) => r.metric !== null).length, shortlisted }, rows };
}
export function binderCandidatesCsv(table: ReturnType<typeof rankBinderCandidates>): string {
  const quote = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const headers = ["candidateId", "sourceRunId", "design", "replicate", "binderSequence", "binderSha256", "targetSha256", "duplicateOf", "status", "metric", "rank", "reasons", "samples", "reports"];
  return [headers.join(","), ...table.rows.map((r) => headers.map((key) => quote(key in r.candidate ? r.candidate[key as keyof PreparedBinderCandidate] : ["reasons", "samples", "reports"].includes(key) ? JSON.stringify(r[key as "reasons"]) : r[key as "status"])).join(","))].join("\n") + "\n";
}
/** Versioned snapshots preserve earlier policies/results; JSON is authoritative. */
export async function writeBinderCandidateTable(directory: string, manifest: BinderCampaignManifest, states: BinderCandidateState[]) {
  const table = rankBinderCandidates(manifest, states);
  fs.mkdirSync(directory, { recursive: true });
  await writeFileExclusive(path.join(directory, "candidates.json"), `${JSON.stringify(table, null, 2)}\n`, 0o600);
  await writeFileExclusive(path.join(directory, "candidates.csv"), binderCandidatesCsv(table), 0o600);
  const lines = table.rows.map((r) => `- ${r.candidate.candidateId}: ${r.status}, score ${r.metric ?? "unavailable"}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}\n${r.reports.map((p) => `  - [Molecular report](${encodeURI(p)})`).join("\n")}`).join("\n");
  await writeFileExclusive(path.join(directory, "index.md"), `# Binder campaign\n\nPolicy: ${manifest.policyRevision}. Aggregation: ${manifest.ranking.aggregation} ipSAE max. Exact sequence deduplication only.\n\n${JSON.stringify(table.counts)}\n\n${lines}\n`);
  return table;
}

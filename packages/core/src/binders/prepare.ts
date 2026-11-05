import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readRfd4Spec, getAdapter } from "@moldesk/adapters";
import { resolveCompanionInputSources } from "@moldesk/runtime";
import { writeFileExclusive } from "@moldesk/visualizer";
import { MoldeskError } from "../errors.js";
import { digest } from "../hash.js";
import { hashArtifact, verifyArtifact, type HashedFile } from "../analysis/boltz-artifacts.js";
import { parseStructure, STANDARD_PROTEIN_RESIDUES, type ParsedChain } from "../analysis/molstar-model.js";
import { readStructureInput } from "../analysis/structure-input.js";
import type { RunRecord } from "../run.js";

export interface FrozenBinderTarget {
  structure: HashedFile; chainAuthId: string; chainLabelId: string; sequence: string; sha256: string;
  residues: Array<{ authSeqId: number; labelSeqId: number | null; name: string }>;
}
export interface FrozenBinderGeneration { spec: HashedFile; inputs: Array<{ role: string; artifact: HashedFile }> }
/** Freeze the approved hotspot/spec bytes and companion structures before generation. */
export async function freezeBinderGeneration(specPath: string): Promise<FrozenBinderGeneration> {
  const adapter = getAdapter("rfd4-proteina")!;
  await adapter.validateInput(specPath);
  const refs = await adapter.resolveCompanionInputs!(specPath);
  const sources = resolveCompanionInputSources({ jobFilePath: specPath, refs });
  return { spec: await hashArtifact(specPath, 1024 ** 2), inputs: await Promise.all(sources.map(async (s) => ({ role: s.id, artifact: await hashArtifact(s.sourcePath) }))) };
}
export interface BinderRoles { targetChain: string; binderChain: string; expectedContig: string; generatedTargetStart: number }
export interface PreparedBinderCandidate {
  candidateId: string; sourceRunId: string; design: string; replicate: number;
  source: HashedFile; sourceJob: HashedFile; sourceChains: { target: string; binder: string };
  targetSha256: string; binderSequence: string; binderSha256: string;
  duplicateOf?: string; job?: HashedFile; mapping?: HashedFile;
}
export function binderError(message: string): never {
  throw new MoldeskError({ code: "INVALID_BINDER_CAMPAIGN", message, remediation: "Verify the frozen target, explicit chain/crop mapping, source run and campaign policy." });
}
export const sequenceHash = (sequence: string): string => createHash("sha256").update(sequence).digest("hex");
function sequence(chain: ParsedChain): string {
  if (chain.entityType !== "polymer" || !chain.residues.length || chain.residues.some((r) => r.kind !== "protein" || !STANDARD_PROTEIN_RESIDUES.has(r.name) || r.hetero || r.insertionCode || !r.hasTraceAtom || !r.letter || !/^[ACDEFGHIKLMNPQRSTVWY]$/.test(r.letter))) binderError("Expected complete standard protein residues with trace atoms.");
  return chain.residues.map((r) => r.letter).join("");
}
function pick(chains: ParsedChain[], id: string): ParsedChain {
  const matches = chains.filter((c) => c.authId === id);
  if (matches.length !== 1) binderError(`Missing/ambiguous author chain: ${id}`);
  return matches[0];
}
/** Explicit modeled-residue crop: never silently substitutes fullSequence for a domain. */
export async function freezeBinderTarget(structurePath: string, chainAuthId: string, residueIds: number[]): Promise<FrozenBinderTarget> {
  const structure = await hashArtifact(structurePath);
  const input = readStructureInput(structurePath);
  if (input.sha256 !== structure.sha256) binderError("Target changed while reading.");
  const parsed = await parseStructure(input);
  if (parsed.modelCount !== 1 || !residueIds.length || new Set(residueIds).size !== residueIds.length) binderError("Choose an explicit, unique residue crop in one model.");
  const chain = pick(parsed.chains, chainAuthId);
  const residues = residueIds.map((id) => {
    const matches = chain.residues.filter((r) => r.authSeqId === id && !r.insertionCode);
    if (matches.length !== 1) binderError(`Missing/ambiguous target residue: ${id}`);
    return matches[0];
  });
  const seq = sequence({ ...chain, residues });
  const frozen = { structure, chainAuthId, chainLabelId: chain.labelId, sequence: seq,
    residues: residues.map(({ authSeqId, labelSeqId, name }) => ({ authSeqId, labelSeqId, name })) };
  return { ...frozen, sha256: digest(frozen) };
}

/** RFD4 outputs → deduplicated, validated Boltz YAMLs. Original inputs are never changed. */
export async function prepareBinderPredictions(options: {
  generation: RunRecord; approvedGeneration: FrozenBinderGeneration; target: FrozenBinderTarget; roles: Record<string, BinderRoles>; outputDir: string;
  previous?: PreparedBinderCandidate[];
}): Promise<PreparedBinderCandidate[]> {
  const { generation: run, target } = options;
  if (run.model !== "rfd4-proteina" || run.status !== "succeeded") binderError("Expected a successful RFD4-Proteina run.");
  const { sha256, ...frozen } = target;
  if (digest(frozen) !== sha256) binderError("Frozen target changed.");
  await verifyArtifact(target.structure);
  const original = await freezeBinderTarget(target.structure.path, target.chainAuthId, target.residues.map((r) => r.authSeqId));
  if (original.sha256 !== target.sha256) binderError("Frozen crop no longer matches its source.");
  const jobs = run.input.filter((i) => i.role === "job" || i.role === undefined);
  if (jobs.length !== 1) binderError("Expected one generation spec.");
  const sourceJob = await hashArtifact(jobs[0].storedPath);
  if (sourceJob.sha256 !== jobs[0].sha256) binderError("Generation spec changed.");
  const approved = options.approvedGeneration;
  await verifyArtifact(approved.spec);
  if (sourceJob.sha256 !== approved.spec.sha256) binderError("Generation spec/hotspots differ from the registered input.");
  const companions = run.input.filter((i) => i.role !== "job" && i.role !== undefined);
  if (companions.length !== approved.inputs.length) binderError("Generation companion inputs differ from the registered protocol.");
  for (const expected of approved.inputs) {
    await verifyArtifact(expected.artifact);
    const matches = companions.filter((i) => i.role === expected.role && i.sha256 === expected.artifact.sha256);
    if (matches.length !== 1 || (await hashArtifact(matches[0].storedPath)).sha256 !== expected.artifact.sha256) binderError("Generation target/companion changed.");
  }
  const spec = readRfd4Spec(sourceJob.path);
  for (const previous of options.previous ?? []) {
    if (previous.sourceJob.sha256 !== approved.spec.sha256 || previous.targetSha256 !== target.sha256 || sequenceHash(previous.binderSequence) !== previous.binderSha256) binderError("Previous candidate belongs to a different target or sequence.");
    for (const file of [previous.source, previous.sourceJob, previous.job, previous.mapping]) if (file) await verifyArtifact(file);
  }
  const seen = new Map((options.previous ?? []).filter((c) => !c.duplicateOf).map((c) => [c.binderSha256, c.candidateId]));
  const outputs = run.outputs.filter((o) => o.id === "generated_structures").sort((a, b) => a.path.localeCompare(b.path));
  const ids = new Set<string>();
  const candidates: PreparedBinderCandidate[] = [];
  for (const source of outputs) {
    await verifyArtifact(source);
    const match = /^(.*)_(\d+)_generated\.cif$/.exec(path.basename(source.path));
    const design = spec.designs.find((d) => d.name === match?.[1]);
    if (!match || !design) binderError(`Unexpected generation output: ${source.path}`);
    const role = options.roles[design.name];
    if (!role || role.targetChain === role.binderChain || role.expectedContig !== design.contig || !Number.isSafeInteger(role.generatedTargetStart)) binderError(`Explicit spec/chain roles missing for ${design.name}.`);
    const parsed = await parseStructure(readStructureInput(source.path));
    if (parsed.modelCount !== 1 || parsed.chains.length !== 2) binderError("Expected exactly two generated chains in one model.");
    const generatedTarget = pick(parsed.chains, role.targetChain), binder = pick(parsed.chains, role.binderChain);
    if (sequence(generatedTarget) !== target.sequence || generatedTarget.residues.some((r, i) => r.authSeqId !== role.generatedTargetStart + i)) binderError("Generated target differs from the frozen sequence/residue mapping.");
    const binderSequence = sequence(binder), binderSha256 = sequenceHash(binderSequence);
    const candidateId = `candidate-${digest([run.id, design.name, Number(match[2])]).slice(0, 24)}`;
    if (ids.has(candidateId)) binderError("Duplicate source design/replicate.");
    ids.add(candidateId);
    const candidate: PreparedBinderCandidate = { candidateId, sourceRunId: run.id, design: design.name, replicate: Number(match[2]), source, sourceJob,
      sourceChains: { target: role.targetChain, binder: role.binderChain }, targetSha256: target.sha256, binderSequence, binderSha256 };
    const duplicateOf = seen.get(binderSha256);
    if (duplicateOf && duplicateOf !== candidateId) candidate.duplicateOf = duplicateOf;
    else {
      seen.set(binderSha256, candidateId);
      fs.mkdirSync(options.outputDir, { recursive: true });
      const jobPath = path.resolve(options.outputDir, `${candidateId}.yaml`);
      // JSON is valid YAML; this avoids another serializer and safely quotes IDs/sequences.
      const job = { version: 1, sequences: [{ protein: { id: "A", sequence: target.sequence, msa: "empty" } }, { protein: { id: "B", sequence: binderSequence, msa: "empty" } }] };
      const mappingPath = path.resolve(options.outputDir, `${candidateId}.mapping.json`);
      const mapping = { candidateId, source, sourceJob, roles: candidate.sourceChains, target, predictionChains: { target: "A", binder: "B" },
        targetResidues: target.residues.map((r, i) => ({ source: r, generatedAuthSeqId: role.generatedTargetStart + i, predictionLabelSeqId: i + 1 })),
        binderResidues: binder.residues.map((r, i) => ({ sourceAuthSeqId: r.authSeqId, sourceLabelSeqId: r.labelSeqId, predictionLabelSeqId: i + 1 })) };
      for (const [file, data] of [[jobPath, job], [mappingPath, mapping]] as const) {
        const content = `${JSON.stringify(data, null, 2)}\n`;
        if (fs.existsSync(file)) { if (fs.readFileSync(file, "utf8") !== content) binderError(`Prepared input changed: ${file}`); }
        else await writeFileExclusive(file, content, 0o600);
      }
      await getAdapter("boltz")!.validateInput(jobPath);
      candidate.job = await hashArtifact(jobPath); candidate.mapping = await hashArtifact(mappingPath);
    }
    candidates.push(candidate);
  }
  if (!candidates.length) binderError("No generated_structures in this run.");
  return candidates;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMoldeskPaths, runCommand, type InstallCommandRunner, type MoldeskPaths } from "@moldesk/runtime";
import { MoldeskError } from "../errors.js";
import { ENVELOPE_SCHEMA_VERSION, type AnalysisEnvelope } from "../schemas/envelope.js";
import { requireUsalign, USALIGN_CITATION } from "../tools/usalign.js";
import { VERSION } from "../version.js";
import type { ResidueId } from "./analyze.js";
import { residueId } from "./analyze.js";
import { parseStructure, type ParsedChain, type ParsedResidue, type ParsedStructure } from "./molstar-model.js";
import { readStructureInput, type StructureInput } from "./structure-input.js";
import { checkReportOutput, type PublishedReport } from "../visualization.js";
import { checkDeviationThreshold, createComparisonReport, DEFAULT_DEVIATION_THRESHOLD } from "./compare-report.js";
import { parseUsalignOutput } from "./usalign-output.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface CompareOptions {
  /** Auth chain id in the first / second structure (single-chain mode). Default: the first polymer chain. */
  chainA?: string;
  chainB?: string;
  /** Align all polymer chains of the first model of each structure (`-mm 1 -ter 1`). */
  multimer?: boolean;
  /** Also write an overlay report: B moved onto A, a deviation chart, residues above the threshold highlighted. */
  report?: { outputPath: string; deviationThreshold?: number; env?: NodeJS.ProcessEnv };
  paths?: MoldeskPaths;
  /** Test seam; defaults to spawning the installed binary. */
  runner?: InstallCommandRunner;
  timeoutMs?: number;
}

export interface MappedResidue extends ResidueId {
  chainAuthId: string;
  name: string;
}

export interface CompareResult {
  mode: "monomer" | "multimer";
  inputs: { a: { path: string; format: "pdb" | "mmcif"; sha256: string }; b: { path: string; format: "pdb" | "mmcif"; sha256: string } };
  /** Auth ids of the compared chains, in alignment order. */
  chains: { a: string[]; b: string[] };
  lengths: { a: number; b: number };
  alignedLength: number;
  /** Å over the aligned residues, as printed by US-align (two decimals). */
  rmsd: number;
  /** Identical / aligned residues. */
  sequenceIdentity: number;
  tmScore: { normalizedByA: number; normalizedByB: number };
  /** Maps A onto B: x' = R x + t. Row-major 4x4, Å. */
  transform: { matrix: number[][] };
  /** Aligned residue pairs, A -> B. */
  mapping: Array<{ a: MappedResidue; b: MappedResidue; /** Å between the two trace atoms after superposition. */ distance: number }>;
  citation: string[];
  /** Present when `report` was requested. */
  report?: PublishedReport & { deviationThreshold: number; residuesAboveThreshold: number };
}

function fail(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

/** The residues US-align reads: ATOM records (and MSE) that have a CA or C3' atom. */
function readableResidues(chain: ParsedChain): ParsedResidue[] {
  return chain.residues.filter((r) => r.hasTraceAtom && (!r.hetero || r.name === "MSE"));
}

function alignableChains(parsed: ParsedStructure): Array<{ chain: ParsedChain; residues: ParsedResidue[] }> {
  return parsed.chains
    .filter((c) => c.entityType === "polymer")
    .map((chain) => ({ chain, residues: readableResidues(chain) }))
    .filter((c) => c.residues.length > 0);
}

function requireChains(file: string, chains: ReturnType<typeof alignableChains>): ReturnType<typeof alignableChains> {
  if (chains.length === 0) {
    throw fail(
      "NO_ALIGNABLE_RESIDUES",
      `${path.basename(file)} has no protein or nucleic-acid residues that can be aligned.`,
      "US-align reads ATOM residues (and MSE) with a CA or C3' atom. Check the file with `moldesk analyze`.",
    );
  }
  return chains;
}

function pickChain(
  side: "A" | "B",
  file: string,
  chains: ReturnType<typeof alignableChains>,
  wanted: string | undefined,
  warnings: AnalysisEnvelope["warnings"],
): { chain: ParsedChain; residues: ParsedResidue[] } {
  requireChains(file, chains);
  if (wanted === undefined) {
    if (chains.length > 1) {
      warnings.push({
        code: "CHAIN_DEFAULTED",
        message: `${path.basename(file)} has ${chains.length} polymer chains (${chains.map((c) => c.chain.authId).join(", ")}); structure ${side} uses chain ${chains[0].chain.authId}. Pass --chain-${side.toLowerCase()} to choose, or --multimer to align all chains.`,
      });
    }
    return chains[0];
  }
  const found = chains.find((c) => c.chain.authId === wanted);
  if (!found) {
    throw fail(
      "CHAIN_NOT_FOUND",
      `${path.basename(file)} has no alignable polymer chain "${wanted}" (auth ids).`,
      `Available chains: ${chains.map((c) => `${c.chain.authId} (${c.residues.length} residues)`).join(", ")}.`,
      { available: chains.map((c) => ({ chainId: c.chain.authId, residues: c.residues.length })) },
    );
  }
  return found;
}

/**
 * Walks US-align's aligned sequence strings and the residues it must have read, giving the a -> b pairs.
 * The ungapped strings must match the residues we expect (an `X` on our side is a wildcard), otherwise the
 * mapping would be a guess and we stop.
 */
function mapResidues(
  alignedA: string[],
  alignedB: string[],
  chainsA: Array<{ chain: ParsedChain; residues: ParsedResidue[] }>,
  chainsB: Array<{ chain: ParsedChain; residues: ParsedResidue[] }>,
  superpose: (p: [number, number, number]) => [number, number, number],
): CompareResult["mapping"] {
  const mismatch = (why: string): MoldeskError =>
    fail("ALIGNMENT_MAPPING_MISMATCH", `Could not map the US-align alignment back to residues: ${why}.`, "The structures may use residues this version does not read the same way. Report this with the files.");
  if (alignedA.length !== chainsA.length || alignedB.length !== chainsB.length || alignedA.length !== alignedB.length) {
    throw mismatch(`US-align aligned ${alignedA.length} vs ${alignedB.length} chains, expected ${chainsA.length} vs ${chainsB.length}`);
  }
  const pairs: CompareResult["mapping"] = [];
  const describe = (chain: ParsedChain, r: ParsedResidue): MappedResidue => ({ chainAuthId: chain.authId, ...residueId(r), name: r.name });
  alignedA.forEach((lineA, c) => {
    const lineB = alignedB[c];
    let ia = 0;
    let ib = 0;
    const [{ chain: chainA, residues: resA }, { chain: chainB, residues: resB }] = [chainsA[c], chainsB[c]];
    for (let k = 0; k < lineA.length; k++) {
      const [ca, cb] = [lineA[k], lineB[k]];
      if (ca !== "-") {
        const expected = resA[ia]?.letter ?? "X";
        if (!resA[ia] || (expected !== "X" && expected.toLowerCase() !== ca.toLowerCase())) throw mismatch(`residue ${ia + 1} of chain ${chainA.authId} in structure A`);
      }
      if (cb !== "-") {
        const expected = resB[ib]?.letter ?? "X";
        if (!resB[ib] || (expected !== "X" && expected.toLowerCase() !== cb.toLowerCase())) throw mismatch(`residue ${ib + 1} of chain ${chainB.authId} in structure B`);
      }
      if (ca !== "-" && cb !== "-") {
        const moved = superpose(resA[ia].trace!);
        const target = resB[ib].trace!;
        pairs.push({
          a: describe(chainA, resA[ia]),
          b: describe(chainB, resB[ib]),
          distance: Number(Math.hypot(moved[0] - target[0], moved[1] - target[1], moved[2] - target[2]).toFixed(3)),
        });
      }
      if (ca !== "-") ia++;
      if (cb !== "-") ib++;
    }
    if (ia !== resA.length || ib !== resB.length) throw mismatch(`chain ${chainA.authId}/${chainB.authId} has ${resA.length}/${resB.length} residues, US-align used ${ia}/${ib}`);
  });
  return pairs;
}

const describeInput = (i: StructureInput) => ({ path: i.path, format: i.format, sha256: i.sha256 });

/** Superposes and scores two structures with the installed US-align, as a `moldesk.compare` envelope. */
export async function compareStructureFiles(fileA: string, fileB: string, options: CompareOptions = {}): Promise<AnalysisEnvelope<CompareResult>> {
  const multimer = options.multimer === true;
  if (multimer && (options.chainA !== undefined || options.chainB !== undefined)) {
    throw fail("INVALID_COMPARE_ARGS", "--multimer cannot be combined with --chain-a or --chain-b.", "Use --multimer alone to align all chains, or choose one chain from each structure.");
  }
  if (options.report) {
    checkDeviationThreshold(options.report.deviationThreshold ?? DEFAULT_DEVIATION_THRESHOLD);
    checkReportOutput(options.report.outputPath);
  }
  const usalign = requireUsalign(options.paths ?? getMoldeskPaths());
  const inputA = readStructureInput(fileA);
  const inputB = readStructureInput(fileB);
  const [parsedA, parsedB] = [await parseStructure(inputA), await parseStructure(inputB)];

  const warnings: AnalysisEnvelope["warnings"] = [];
  const all = [alignableChains(parsedA), alignableChains(parsedB)];
  const picked = multimer
    ? [requireChains(inputA.path, all[0]), requireChains(inputB.path, all[1])]
    : [
        [pickChain("A", inputA.path, all[0], options.chainA, warnings)],
        [pickChain("B", inputB.path, all[1], options.chainB, warnings)],
      ];
  for (const [parsed, input] of [[parsedA, inputA], [parsedB, inputB]] as const) {
    if (parsed.modelCount > 1) warnings.push({ code: "MULTIPLE_MODELS", message: `${path.basename(input.path)} has ${parsed.modelCount} models; only the first is compared.` });
  }

  const args = [inputA.path, inputB.path, "-outfmt", "-1", "-m", "-", "-het", "2"];
  if (multimer) args.push("-mm", "1", "-ter", "1");
  else args.push("-chain1", picked[0][0].chain.authId || "_", "-chain2", picked[1][0].chain.authId || "_");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "moldesk-usalign-"));
  let result;
  try {
    result = await (options.runner ?? runCommand)(usalign.executable, args, { cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  if (result.timedOut) throw fail("USALIGN_TIMEOUT", "US-align timed out.", "Compare a smaller selection (--chain-a / --chain-b) or fewer chains.");
  if (result.stdout.length > MAX_OUTPUT_BYTES) throw fail("USALIGN_OUTPUT_TOO_LARGE", "US-align produced unexpectedly large output.", "Compare a smaller selection.");
  if (!result.stdout.includes("Aligned length=")) {
    const reason = (result.stderr || result.stdout).trim().split("\n").filter((l) => !l.startsWith("#Total CPU")).slice(-3).join(" ");
    throw fail("USALIGN_NO_RESULT", `US-align produced no alignment${reason ? `: ${reason}` : ""}${result.code !== 0 ? ` (exit ${result.code})` : ""}.`, "Check that both files contain polymer chains with CA or C3' atoms (`moldesk analyze`).");
  }

  const out = parseUsalignOutput(result.stdout);
  // Multimer output puts a `*` after every chain, the last one included.
  const chainsOf = (aligned: string): string[] => aligned.replace(/\*$/, "").split("*");
  const [u, t] = [out.rotation, out.translation];
  const superpose = (p: [number, number, number]): [number, number, number] => [0, 1, 2].map((i) => t[i] + u[i][0] * p[0] + u[i][1] * p[1] + u[i][2] * p[2]) as [number, number, number];
  const mapping = mapResidues(chainsOf(out.alignedA), chainsOf(out.alignedB), picked[0], picked[1], superpose);
  const envelope: AnalysisEnvelope<CompareResult> = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind: "moldesk.compare",
    status: "ok",
    result: {
      mode: multimer ? "multimer" : "monomer",
      inputs: { a: describeInput(inputA), b: describeInput(inputB) },
      chains: { a: picked[0].map((c) => c.chain.authId), b: picked[1].map((c) => c.chain.authId) },
      lengths: { a: out.lengthA, b: out.lengthB },
      alignedLength: out.alignedLength,
      rmsd: out.rmsd,
      sequenceIdentity: out.sequenceIdentity,
      tmScore: { normalizedByA: out.tmScoreByA, normalizedByB: out.tmScoreByB },
      transform: { matrix: [[...u[0], t[0]], [...u[1], t[1]], [...u[2], t[2]], [0, 0, 0, 1]] },
      mapping,
      citation: USALIGN_CITATION,
    },
    warnings,
    provenance: { moldeskVersion: VERSION, tool: { name: "usalign", version: usalign.version } },
  };
  if (options.report) {
    envelope.result.report = await createComparisonReport(envelope.result, { ...options.report, outputPath: options.report.outputPath });
  }
  return envelope;
}

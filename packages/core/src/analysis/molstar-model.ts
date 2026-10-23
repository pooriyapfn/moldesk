// The only module that touches Mol*. It turns a parsed model into plain data so the rest of
// the analysis (and its tests) never sees Mol* types. Mol* is loaded lazily: it is large and
// most CLI commands never need it.
import { MoldeskError } from "../errors.js";
import type { StructureInput } from "./structure-input.js";

export const MOLSTAR_VERSION = "5.12.0";

export type ResidueKind = "protein" | "dna" | "rna" | "other";
export type SecondaryStructureCode = "H" | "E" | "C";

export interface ParsedResidue {
  authSeqId: number;
  /** Null for non-polymer residues (mmCIF has no label_seq_id for them). */
  labelSeqId: number | null;
  insertionCode?: string;
  name: string;
  kind: ResidueKind;
  /** One-letter code for polymer residues (`X` when non-standard). */
  letter?: string;
  secondaryStructure?: SecondaryStructureCode;
  /** Heavy atoms kept (first alternate location only). */
  atomCount: number;
  /** Mean B-factor of the residue's kept atoms; the caller decides whether it means anything. */
  bfactor: number | null;
}

export interface ParsedChain {
  authId: string;
  labelId: string;
  entityId: string;
  entityType: "polymer" | "non-polymer" | "branched" | "water" | "unknown";
  residueCount: number;
  /** Empty for water chains. */
  residues: ParsedResidue[];
}

export interface ParsedStructure {
  modelCount: number;
  /** Chains of the first model. */
  chains: ParsedChain[];
  secondaryStructureSource: "file" | "computed" | "none";
  /** Heavy, non-water atoms of the first model (first alternate location only). */
  atoms: { x: Float64Array; y: Float64Array; z: Float64Array; mass: Float64Array };
  /** The same heavy atoms with names and owners, for neighbour searches. `chain`/`residue` index into `chains[]` / `chains[].residues`. */
  heavyAtoms: { x: Float64Array; y: Float64Array; z: Float64Array; name: string[]; chain: Int32Array; residue: Int32Array };
  /** Atoms left out of the geometry because their element has no known mass. */
  atomsWithoutMass: number;
  /** mmCIF `pdbx_unobs_or_zero_occ_residues` rows for the first model. */
  unobserved: Array<{ authChainId: string; authSeqId: number; insertionCode?: string; labelSeqId: number | null; name: string }>;
  /** ModelCIF local pLDDT keyed `${labelAsymId}:${labelSeqId}`; undefined when the file has none. */
  modelcifPlddt?: Map<string, number>;
}

function parseFailed(message: string): MoldeskError {
  return new MoldeskError({
    code: "STRUCTURE_PARSE_FAILED",
    message,
    remediation: "The file may be truncated or malformed. Provide a complete PDB or mmCIF file.",
  });
}

const ENTITY_TYPES = new Set(["polymer", "non-polymer", "branched", "water"]);

export async function parseStructure(input: StructureInput): Promise<ParsedStructure> {
  const [{ parsePDB }, { CIF }, { trajectoryFromPDB }, { trajectoryFromMmCIF }] = await Promise.all([
    import("molstar/lib/mol-io/reader/pdb/parser.js"),
    import("molstar/lib/mol-io/reader/cif.js"),
    import("molstar/lib/mol-model-formats/structure/pdb.js"),
    import("molstar/lib/mol-model-formats/structure/mmcif.js"),
  ]);
  const { Structure, Unit } = await import("molstar/lib/mol-model/structure.js");
  const { MoleculeType, SecondaryStructureType } = await import("molstar/lib/mol-model/structure/model/types.js");
  const { getProteinOneLetterCode, getDnaOneLetterCode, getRnaOneLetterCode } = await import(
    "molstar/lib/mol-model/sequence/constants.js"
  );
  const { ModelSecondaryStructure } = await import("molstar/lib/mol-model-formats/structure/property/secondary-structure.js");
  const { computeUnitDSSP, DefaultDSSPComputationProps } = await import(
    "molstar/lib/mol-model-props/computed/secondary-structure/dssp.js"
  );
  const { AtomicNumbers, ElementAtomWeights } = await import("molstar/lib/mol-model/structure/model/properties/atomic/measures.js");

  let block: import("molstar/lib/mol-io/reader/cif.js").CifBlock | undefined;
  let trajectory;
  try {
    if (input.format === "pdb") {
      const parsed = await parsePDB(input.text, input.path).run();
      if (parsed.isError) throw parseFailed(parsed.message);
      trajectory = await trajectoryFromPDB(parsed.result).run();
    } else {
      const parsed = await CIF.parse(input.text).run();
      if (parsed.isError) throw parseFailed(parsed.message);
      block = parsed.result.blocks[0];
      if (!block) throw parseFailed("No data block found.");
      trajectory = await trajectoryFromMmCIF(block).run();
    }
  } catch (error) {
    throw error instanceof MoldeskError ? error : parseFailed(error instanceof Error ? error.message : String(error));
  }
  if (trajectory.frameCount === 0) throw parseFailed("The file contains no models.");
  const frame = trajectory.getFrameAtIndex(0);
  const model = "run" in frame ? await frame.run() : frame;
  if (model.atomicHierarchy.atoms._rowCount === 0) throw parseFailed("The file contains no atoms.");

  const h = model.atomicHierarchy;
  const conf = model.atomicConformation;

  // Secondary structure: the file's own records when it has any helix/sheet, otherwise DSSP.
  const fileSs = ModelSecondaryStructure.Provider.get(model);
  const hasFileSs = !!fileSs && fileSs.elements.some((e) => e.kind === "helix" || e.kind === "sheet");
  const ssFlags = new Map<number, number>(); // residue index -> SecondaryStructureType flags
  if (!hasFileSs) {
    for (const unit of Structure.ofModel(model).units) {
      if (!Unit.isAtomic(unit)) continue;
      const ss = await computeUnitDSSP(unit, DefaultDSSPComputationProps);
      for (let k = 0; k < unit.elements.length; k++) {
        const r = unit.residueIndex[unit.elements[k]];
        const i = ss.getIndex(r);
        if (i >= 0) ssFlags.set(r, ss.type[i]);
      }
    }
  }
  const secondaryOf = (r: number): SecondaryStructureCode => {
    const flags = hasFileSs ? fileSs!.type[fileSs!.getIndex(r as never)] : ssFlags.get(r) ?? 0;
    if (SecondaryStructureType.is(flags, SecondaryStructureType.Flag.Helix)) return "H";
    if (SecondaryStructureType.is(flags, SecondaryStructureType.Flag.Beta)) return "E";
    return "C";
  };

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const ms: number[] = [];
  const heavy = { x: [] as number[], y: [] as number[], z: [] as number[], name: [] as string[], chain: [] as number[], residue: [] as number[] };
  let atomsWithoutMass = 0;

  const chains: ParsedChain[] = [];
  for (let c = 0; c < h.chains._rowCount; c++) {
    const entityId = h.chains.label_entity_id.value(c);
    const entityIndex = model.entities.getEntityIndex(entityId);
    const rawType = entityIndex >= 0 ? model.entities.data.type.value(entityIndex) : "unknown";
    const entityType = (ENTITY_TYPES.has(rawType) ? rawType : "unknown") as ParsedChain["entityType"];
    const rStart = h.residueAtomSegments.index[h.chainAtomSegments.offsets[c]];
    const rEnd = h.residueAtomSegments.index[h.chainAtomSegments.offsets[c + 1] - 1] + 1;
    const chain: ParsedChain = {
      authId: h.chains.auth_asym_id.value(c),
      labelId: h.chains.label_asym_id.value(c),
      entityId,
      entityType,
      residueCount: 0,
      residues: [],
    };
    let previous = "";
    for (let r = rStart; r < rEnd; r++) {
      const first = h.residueAtomSegments.offsets[r];
      const last = h.residueAtomSegments.offsets[r + 1];
      const moleculeType = h.derived.residue.moleculeType[r];
      const authSeqId = h.residues.auth_seq_id.value(r);
      const ins = h.residues.pdbx_PDB_ins_code.value(r);
      // Microheterogeneity repeats a polymer residue number; keep the first.
      const key = `${authSeqId}${ins}`;
      if (entityType === "polymer" && key === previous) continue;
      previous = key;
      chain.residueCount++;
      if (entityType === "water") continue;

      // First alternate location only.
      let alt = "";
      for (let a = first; a < last; a++) {
        const id = h.atoms.label_alt_id.value(a);
        if (id !== "" && (alt === "" || id < alt)) alt = id;
      }
      let bSum = 0;
      let bCount = 0;
      for (let a = first; a < last; a++) {
        const id = h.atoms.label_alt_id.value(a);
        if (id !== "" && id !== alt) continue;
        const element = h.atoms.type_symbol.value(a);
        if (element === "H" || element === "D") continue;
        bSum += conf.B_iso_or_equiv.value(a);
        bCount++;
        heavy.x.push(conf.x[a]);
        heavy.y.push(conf.y[a]);
        heavy.z.push(conf.z[a]);
        heavy.name.push(h.atoms.label_atom_id.value(a));
        heavy.chain.push(c);
        heavy.residue.push(chain.residues.length);
        const number = (AtomicNumbers as Record<string, number | undefined>)[element];
        const mass = number === undefined ? undefined : (ElementAtomWeights as Record<number, number>)[number];
        if (mass === undefined) {
          atomsWithoutMass++;
          continue;
        }
        xs.push(conf.x[a]);
        ys.push(conf.y[a]);
        zs.push(conf.z[a]);
        ms.push(mass);
      }

      const name = h.atoms.label_comp_id.value(first);
      const kind: ResidueKind =
        moleculeType === MoleculeType.Protein ? "protein"
        : moleculeType === MoleculeType.DNA ? "dna"
        : moleculeType === MoleculeType.RNA ? "rna"
        : "other";
      const labelSeqId = h.residues.label_seq_id.value(r);
      chain.residues.push({
        authSeqId,
        labelSeqId: labelSeqId > 0 ? labelSeqId : null,
        ...(ins ? { insertionCode: ins } : {}),
        name,
        kind,
        ...(kind === "protein" ? { letter: getProteinOneLetterCode(name) } : {}),
        ...(kind === "dna" ? { letter: getDnaOneLetterCode(name) } : {}),
        ...(kind === "rna" ? { letter: getRnaOneLetterCode(name) } : {}),
        ...(kind === "protein" ? { secondaryStructure: secondaryOf(r) } : {}),
        atomCount: bCount,
        bfactor: bCount > 0 ? bSum / bCount : null,
      });
    }
    chains.push(chain);
  }

  return {
    modelCount: trajectory.frameCount,
    chains,
    secondaryStructureSource: chains.some((c) => c.residues.some((r) => r.secondaryStructure)) ? (hasFileSs ? "file" : "computed") : "none",
    atoms: { x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs), mass: Float64Array.from(ms) },
    heavyAtoms: {
      x: Float64Array.from(heavy.x),
      y: Float64Array.from(heavy.y),
      z: Float64Array.from(heavy.z),
      name: heavy.name,
      chain: Int32Array.from(heavy.chain),
      residue: Int32Array.from(heavy.residue),
    },
    atomsWithoutMass,
    unobserved: block ? readUnobserved(block) : [],
    modelcifPlddt: block ? readModelcifPlddt(block) : undefined,
  };
}

type CifBlock = import("molstar/lib/mol-io/reader/cif.js").CifBlock;

function readUnobserved(block: CifBlock): ParsedStructure["unobserved"] {
  const cat = block.categories["pdbx_unobs_or_zero_occ_residues"];
  if (!cat) return [];
  const model = cat.getField("PDB_model_num");
  const chain = cat.getField("auth_asym_id");
  const seq = cat.getField("auth_seq_id");
  const ins = cat.getField("PDB_ins_code");
  const labelSeq = cat.getField("label_seq_id");
  const name = cat.getField("auth_comp_id");
  if (!chain || !seq) return [];
  const rows: ParsedStructure["unobserved"] = [];
  for (let i = 0; i < cat.rowCount; i++) {
    if (model && model.int(i) !== 1) continue;
    const insertion = ins?.str(i) ?? "";
    const label = labelSeq?.int(i) ?? 0;
    rows.push({
      authChainId: chain.str(i),
      authSeqId: seq.int(i),
      ...(insertion && insertion !== "?" && insertion !== "." ? { insertionCode: insertion } : {}),
      labelSeqId: label > 0 ? label : null,
      name: name?.str(i) ?? "",
    });
  }
  return rows;
}

/** Local pLDDT from the ModelCIF `ma_qa_metric` / `ma_qa_metric_local` categories (model 1). */
function readModelcifPlddt(block: CifBlock): Map<string, number> | undefined {
  const metrics = block.categories["ma_qa_metric"];
  const local = block.categories["ma_qa_metric_local"];
  if (!metrics || !local) return undefined;
  const id = metrics.getField("id");
  const name = metrics.getField("name");
  const mode = metrics.getField("mode");
  if (!id || !name) return undefined;
  let metricId: string | undefined;
  for (let i = 0; i < metrics.rowCount; i++) {
    if (/^plddt$/i.test(name.str(i)) && (!mode || mode.str(i) === "local")) metricId = id.str(i);
  }
  if (metricId === undefined) return undefined;
  const metric = local.getField("metric_id");
  const value = local.getField("metric_value");
  const asym = local.getField("label_asym_id");
  const seq = local.getField("label_seq_id");
  const modelId = local.getField("model_id");
  if (!metric || !value || !asym || !seq) return undefined;
  const values = new Map<string, number>();
  for (let i = 0; i < local.rowCount; i++) {
    if (metric.str(i) !== metricId || (modelId && modelId.int(i) !== 1)) continue;
    values.set(`${asym.str(i)}:${seq.int(i)}`, value.float(i));
  }
  return values.size > 0 ? values : undefined;
}

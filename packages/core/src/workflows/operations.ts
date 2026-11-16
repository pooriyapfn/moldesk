import { STRUCTURE_EXTENSIONS } from "../analysis/structure-input.js";
import { MoldeskError } from "../errors.js";

export type WorkflowValueType = "structure_file" | "protein_sequence" | "protein_structure" | "json";

export type WorkflowBackend = "local";

export interface WorkflowOperationInput {
  name: string;
  type: WorkflowValueType;
  required: boolean;
  formats?: readonly string[];
}

export interface WorkflowOperationOutput {
  name: string;
  type: WorkflowValueType;
}

export interface WorkflowOperation {
  uses: string;
  summary: string;
  backend: WorkflowBackend;
  inputs: readonly WorkflowOperationInput[];
  outputs: readonly WorkflowOperationOutput[];
  requirements: {
    model?: string;
    structureFormats?: readonly string[];
    singleChain?: boolean;
  };
}

export const WORKFLOW_INPUT_TYPES = ["structure_file", "protein_sequence"] as const;

export const MAX_PROTEIN_SEQUENCE_LENGTH = 4096;

const STRUCTURE_FORMATS = STRUCTURE_EXTENSIONS;
const STANDARD_AMINO_ACIDS = /^[ACDEFGHIKLMNPQRSTVWY]+$/;

export const WORKFLOW_OPERATIONS = {
  "moldesk/import-structure@1": {
    uses: "moldesk/import-structure@1",
    summary: "Validate a local PDB/mmCIF file containing a protein chain.",
    backend: "local",
    inputs: [{ name: "file", type: "structure_file", required: true, formats: STRUCTURE_FORMATS }],
    outputs: [{ name: "structure", type: "protein_structure" }],
    requirements: { structureFormats: STRUCTURE_FORMATS },
  },
  "moldesk/structure-analysis@1": {
    uses: "moldesk/structure-analysis@1",
    summary: "Summarize a protein structure as a moldesk.analysis envelope.",
    backend: "local",
    inputs: [{ name: "structure", type: "protein_structure", required: true }],
    outputs: [{ name: "report", type: "json" }],
    requirements: {},
  },
  "moldesk/boltz@1": {
    uses: "moldesk/boltz@1",
    summary: "Predict one protein chain with a ready local Boltz installation.",
    backend: "local",
    inputs: [{ name: "sequence", type: "protein_sequence", required: true }],
    outputs: [{ name: "structure", type: "protein_structure" }],
    requirements: { model: "boltz", singleChain: true },
  },
} as const satisfies Record<string, WorkflowOperation>;

export type WorkflowOperationId = keyof typeof WORKFLOW_OPERATIONS;

export const WORKFLOW_OPERATION_IDS = Object.freeze(Object.keys(WORKFLOW_OPERATIONS)) as readonly WorkflowOperationId[];

export function getWorkflowOperation(uses: string): WorkflowOperation | undefined {
  return (WORKFLOW_OPERATIONS as Record<string, WorkflowOperation>)[uses];
}

export function workflowOperationCatalog(): WorkflowOperation[] {
  return WORKFLOW_OPERATION_IDS.map((uses) => WORKFLOW_OPERATIONS[uses]);
}

export function normalizeProteinSequence(value: unknown): string {
  if (typeof value !== "string") {
    throw new MoldeskError({
      code: "INVALID_PROTEIN_SEQUENCE",
      message: "Protein sequence input must be a plain sequence string, not a structured model job.",
      remediation: "Pass one chain of standard amino-acid letters, for example ACDEFGHIKLMNPQRSTVWY.",
    });
  }
  const sequence = value.trim().toUpperCase();
  if (sequence.length === 0) {
    throw new MoldeskError({
      code: "INVALID_PROTEIN_SEQUENCE",
      message: "Protein sequence input is empty.",
      remediation: "Provide at least one standard amino-acid letter.",
    });
  }
  if (sequence.length > MAX_PROTEIN_SEQUENCE_LENGTH) {
    throw new MoldeskError({
      code: "INVALID_PROTEIN_SEQUENCE",
      message: `Protein sequence has ${sequence.length} residues; the single-chain limit is ${MAX_PROTEIN_SEQUENCE_LENGTH}.`,
      remediation: "Shorten the sequence to one supported chain.",
    });
  }
  if (!STANDARD_AMINO_ACIDS.test(sequence)) {
    throw new MoldeskError({
      code: "INVALID_PROTEIN_SEQUENCE",
      message: "Protein sequence contains characters outside the standard amino-acid alphabet.",
      remediation: "Use only ACDEFGHIKLMNPQRSTVWY.",
    });
  }
  return sequence;
}

/** Boltz job for one protein chain with an empty MSA, matching examples/boltz/protein.yaml. */
export interface BoltzMonomerInput {
  version: 1;
  sequences: [{ protein: { id: "A"; sequence: string; msa: "empty" } }];
}

export function buildBoltzMonomerInput(value: unknown): BoltzMonomerInput {
  return {
    version: 1,
    sequences: [{ protein: { id: "A", sequence: normalizeProteinSequence(value), msa: "empty" } }],
  };
}
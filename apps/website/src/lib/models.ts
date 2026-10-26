// First-fold data for each model page (<ModelHero />). Speed and cost numbers are
// not stored here: they come from lib/benchmarks.ts so the two can't disagree.

export type ModelStatus = "available" | "beta" | "soon";

export type AppleSiliconRun = {
  seconds: number;
  /** Machine and workload, shown under the number. */
  label: string;
};

export type ModelInfo = {
  slug: string;
  displayName: string;
  /** One sentence: what the model does. */
  tagline: string;
  status: ModelStatus;
  license: string;
  upstream: string;
  appleSilicon: boolean;
  nvidiaCuda: boolean;
  install?: string;
  run?: string;
  /** Measured Apple Silicon run, when one is recorded. */
  appleSiliconRun?: AppleSiliconRun;
};

export const models: Record<string, ModelInfo> = {
  boltz: {
    slug: "boltz",
    displayName: "Boltz-2",
    tagline: "Predict 3D structure and binding affinity of proteins, ligands and complexes.",
    status: "available",
    license: "MIT",
    upstream: "https://github.com/jwohlwend/boltz",
    appleSilicon: true,
    nvidiaCuda: true,
    install: "moldesk install boltz",
    run: "moldesk run boltz input.yaml",
    appleSiliconRun: { seconds: 88, label: "Apple M3, 115-residue protein" },
  },
  diffdock: {
    slug: "diffdock",
    displayName: "DiffDock-L",
    tagline: "Dock a small molecule into a protein without knowing the pocket, with ranked poses.",
    status: "available",
    license: "MIT",
    upstream: "https://github.com/gcorso/DiffDock",
    appleSilicon: false,
    nvidiaCuda: true,
    install: "moldesk install diffdock",
    run: "moldesk run diffdock job.json",
  },
  bindcraft2: {
    slug: "bindcraft2",
    displayName: "BindCraft2",
    tagline: "Design protein binders against a target in bounded, budgeted campaigns.",
    status: "beta",
    license: "Source-available",
    upstream: "https://github.com/PacesaLab/BindCraft2",
    appleSilicon: false,
    nvidiaCuda: true,
    install: "moldesk install bindcraft2",
    run: "moldesk run bindcraft2 campaign.json",
  },
  "rfd4-proteina": {
    slug: "rfd4-proteina",
    displayName: "RFD4-Proteina",
    tagline: "Design proteins, binders, enzymes and antibodies from a short condition spec.",
    status: "available",
    license: "BSD-3-Clause",
    upstream: "https://github.com/RosettaCommons/RFD4-Proteina",
    appleSilicon: false,
    nvidiaCuda: true,
    install: "moldesk install rfd4-proteina",
    run: "moldesk run rfd4-proteina design.yaml",
  },
  opendde: {
    slug: "opendde",
    displayName: "OpenDDE Preview",
    tagline: "Co-fold proteins, DNA, RNA, ligands and ions into all-atom complex structures.",
    status: "available",
    license: "Apache-2.0",
    upstream: "https://github.com/aurekaresearch/OpenDDE",
    appleSilicon: true,
    nvidiaCuda: true,
    install: "moldesk install opendde",
    run: "moldesk run opendde job.json",
    appleSiliconRun: { seconds: 26, label: "Apple M3, 9-residue peptide" },
  },
  proteinmpnn: {
    slug: "proteinmpnn",
    displayName: "ProteinMPNN",
    tagline: "Design new amino-acid sequences that fold into a given protein backbone.",
    status: "available",
    license: "MIT",
    upstream: "https://github.com/dauparas/ProteinMPNN",
    appleSilicon: true,
    nvidiaCuda: true,
    install: "moldesk install proteinmpnn",
    run: "moldesk run proteinmpnn 1UBQ.pdb --output ./results",
  },
  ligandmpnn: {
    slug: "ligandmpnn",
    displayName: "LigandMPNN",
    tagline: "Design sequences that account for bound ligands and multi-chain partners.",
    status: "available",
    license: "MIT",
    upstream: "https://github.com/dauparas/LigandMPNN",
    appleSilicon: true,
    nvidiaCuda: true,
    install: "moldesk install ligandmpnn",
    run: "moldesk run ligandmpnn 3PTB.pdb --output ./results",
  },
  alphafold: {
    slug: "alphafold",
    displayName: "AlphaFold",
    tagline: "DeepMind's protein structure prediction model.",
    status: "soon",
    license: "Apache-2.0",
    upstream: "https://github.com/google-deepmind/alphafold",
    appleSilicon: false,
    nvidiaCuda: false,
  },
  colabfold: {
    slug: "colabfold",
    displayName: "ColabFold",
    tagline: "Faster AlphaFold-family structure prediction with MMseqs2 MSAs.",
    status: "soon",
    license: "MIT",
    upstream: "https://github.com/sokrypton/ColabFold",
    appleSilicon: false,
    nvidiaCuda: false,
  },
  chai: {
    slug: "chai",
    displayName: "Chai-1",
    tagline: "Biomolecular structure prediction from Chai Discovery.",
    status: "soon",
    license: "Apache-2.0",
    upstream: "https://github.com/chaidiscovery/chai-lab",
    appleSilicon: false,
    nvidiaCuda: false,
  },
};

export const CLI_INSTALL = "curl -fsSL https://moleculedesk.com/install.sh | sh";
export const AGENT_INSTALL = "claude plugin install moldesk --marketplace pooriyapfn/moldesk";
export const REPO_URL = "https://github.com/pooriyapfn/moldesk";

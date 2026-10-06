export type DocStatus = "beta" | "planned" | "soon";

export type DocNavItem = {
  title: string;
  slug: string;
  status?: DocStatus;
};

export type DocNavSection = {
  title: string;
  items: DocNavItem[];
};

export const docsNav: DocNavSection[] = [
  {
    title: "Get started",
    items: [
      { title: "Overview", slug: "" },
      { title: "Installation", slug: "installation" },
      { title: "CLI usage", slug: "cli-usage" },
    ],
  },
  {
    title: "Concepts",
    items: [
      { title: "Architecture", slug: "architecture" },
      { title: "Model compatibility & registry", slug: "model-compatibility" },
      { title: "Benchmarks: speed & cost", slug: "benchmarks" },
    ],
  },
  {
    title: "Models",
    items: [
      { title: "Boltz-2", slug: "models/boltz", status: "beta" },
      { title: "DiffDock-L", slug: "models/diffdock", status: "planned" },
      { title: "BindCraft2", slug: "models/bindcraft2", status: "planned" },
      { title: "OpenDDE Preview", slug: "models/opendde", status: "beta" },
      { title: "ProteinMPNN", slug: "models/proteinmpnn", status: "beta" },
      { title: "LigandMPNN", slug: "models/ligandmpnn", status: "beta" },
      { title: "AlphaFold", slug: "models/alphafold", status: "soon" },
      { title: "ColabFold", slug: "models/colabfold", status: "soon" },
      { title: "Chai", slug: "models/chai", status: "soon" },
    ],
  },
  {
    title: "Guides",
    items: [
      { title: "Run Boltz-2 locally", slug: "guides/run-boltz-locally" },
      { title: "Molecular AI on Apple Silicon", slug: "guides/apple-silicon" },
    ],
  },
  {
    title: "Help",
    items: [{ title: "Troubleshooting & FAQ", slug: "troubleshooting" }],
  },
];

export function flattenDocsNav(): DocNavItem[] {
  return docsNav.flatMap((section) => section.items);
}

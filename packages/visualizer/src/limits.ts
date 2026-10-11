// Named bounds for report contents. Shared by the Node exporter/updater and the
// browser viewer, so it must stay free of Node and DOM imports. Values are
// practical starting points; see docs/visualizer.md for measurements.

const MiB = 1024 * 1024;

export const REPORT_LIMITS = {
  /** Largest single source file (original bytes) embedded in a report. */
  maxResourceBytes: 64 * MiB,
  /** Sum of all embedded original bytes in one report. */
  maxTotalResourceBytes: 256 * MiB,
  /** Largest report HTML file the updater will read. Covers base64 overhead + viewer. */
  maxReportFileBytes: 400 * MiB,
  maxResources: 512,
  maxScenes: 256,
  maxStructuresPerScene: 64,
  maxComponentsPerScene: 128,
  maxPanels: 64,
  maxColumns: 64,
  maxSelectionIds: 1024,
  maxResidueRefs: 10_000,
  maxIdLength: 128,
  maxLabelLength: 256,
  maxTitleLength: 512,
  maxFieldLength: 128,
  /** Bounds for parsed tabular data (CSV rows or JSON arrays). */
  maxTableRows: 100_000,
  maxTableCells: 2_000_000,
  maxCellLength: 4096,
} as const;

import type {
  Panel,
  ReportDescription,
  ResourceFormat,
  Scene,
  SourceRef,
} from "@moldesk/visualizer/contract";

/**
 * Small helper for adapters' `describeVisualization`: assigns report-local resource ids,
 * reuses one resource when several scenes reference the same file, and puts the structure
 * panel first. Holds descriptions only — file reads and verification happen in core.
 */
export class ReportBuilder {
  private readonly resources: ReportDescription["resources"] = [];
  private readonly byKey = new Map<string, string>();
  private readonly scenes: Scene[] = [];
  private readonly panels: Panel[] = [];

  /** Adds (or reuses) a resource for an exact collected output or staged input path. */
  resource(source: SourceRef, format: ResourceFormat, label: string): string {
    const key = `${source.kind}\0${source.path}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const id = `r${this.resources.length + 1}`;
    this.resources.push({ id, source, format, label });
    this.byKey.set(key, id);
    return id;
  }

  scene(scene: Scene): void {
    this.scenes.push(scene);
  }

  /** A table over one JSON/CSV resource; empty `columns` shows every field present in the data. */
  table(
    title: string,
    resourceId: string,
    columns: Array<{ field: string; label: string }> = [],
    rowsKey?: string,
  ): void {
    this.panels.push({
      id: `table-${this.panels.length + 1}`,
      kind: "table",
      title,
      dataset: { resourceId, ...(rowsKey === undefined ? {} : { rowsKey }) },
      columns,
    });
  }

  get sceneCount(): number {
    return this.scenes.length;
  }

  build(title: string): ReportDescription {
    const panels: Panel[] =
      this.scenes.length > 0
        ? [{ id: "structures", kind: "structure", sceneIds: this.scenes.map((s) => s.id) }, ...this.panels]
        : this.panels;
    return { title, resources: this.resources, scenes: this.scenes, panels };
  }
}

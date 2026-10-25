import { StrictMode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isMolecularFormat, validateReport, type ChartSpec, type Column, type MolecularReportV1, type Panel, type Scene } from "../contract";
import { csvRecords, parseCsv } from "../csv";
import { lineChartLayout } from "./chart";
import { REPORT_LIMITS } from "../limits";
import { Viewer, type LoadedResource, type RepresentationKind, type SceneSummary, type SequenceRow } from "./molstar";
import { updateCommand } from "./shell";

interface Envelope {
  payload: string;
  payloadSha256: string;
  viewer: { version: string; molstarVersion: string };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(data: Uint8Array | string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Loaded {
  report: MolecularReportV1;
  envelope: Envelope;
  resources: Map<string, LoadedResource>;
  rawBytes: Map<string, Uint8Array>;
}

async function loadReport(): Promise<Loaded> {
  const el = document.getElementById("moldesk-report");
  if (!el?.textContent) throw new Error("This report is missing its data.");
  const envelope = JSON.parse(el.textContent) as Envelope;
  // Integrity check where the browser offers SubtleCrypto; the CLI always verifies.
  const digest = await sha256Hex(envelope.payload);
  if (digest !== undefined && digest !== envelope.payloadSha256) {
    throw new Error("This report's data does not match its recorded checksum and was not opened.");
  }
  const report = validateReport(JSON.parse(new TextDecoder().decode(base64ToBytes(envelope.payload))));
  const resources = new Map<string, LoadedResource>();
  const rawBytes = new Map<string, Uint8Array>();
  for (const r of report.resources) {
    const bytes = base64ToBytes(r.data);
    rawBytes.set(r.id, bytes);
    if (isMolecularFormat(r.format)) resources.set(r.id, { format: r.format, bytes });
  }
  return { report, envelope, resources, rawBytes };
}

function UpdateModal({ onClose }: { onClose: () => void }) {
  const command = updateCommand(location);
  const pre = useRef<HTMLPreElement>(null);
  const [note, setNote] = useState("");
  const copy = async () => {
    try {
      // writeText can wait forever on a permission prompt (notably under file:), so bound it.
      await Promise.race([
        navigator.clipboard.writeText(command),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
      ]);
      setNote("Copied.");
    } catch {
      const node = pre.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setNote("Your browser blocked copying. The command is selected; copy it manually.");
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="md-modal-backdrop" onClick={onClose}>
      <div className="md-modal" role="dialog" aria-modal="true" aria-labelledby="md-update-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="md-update-title">Update viewer</h2>
        <p>Use your installed MoleculeDesk to update this report.</p>
        <ol>
          <li>Copy the command below.</li>
          <li>Run it in your terminal and confirm.</li>
          <li>Refresh this report when finished.</li>
        </ol>
        <pre ref={pre} data-testid="update-command">{command}</pre>
        <div className="md-row">
          <button onClick={copy}>Copy command</button>
          <button onClick={onClose}>Close</button>
          <span role="status">{note}</span>
        </div>
      </div>
    </div>
  );
}

function rowsFor(panel: Extract<Panel, { kind: "table" | "chart" }>, loaded: Loaded) {
  const resource = loaded.report.resources.find((r) => r.id === panel.dataset.resourceId);
  const bytes = loaded.rawBytes.get(panel.dataset.resourceId);
  if (!resource || !bytes) throw new Error("Table data is missing.");
  const text = new TextDecoder().decode(bytes);
  let records: Array<Record<string, unknown>>;
  if (resource.format === "csv") {
    records = csvRecords(parseCsv(text));
  } else {
    const root: unknown = JSON.parse(text);
    const rows =
      panel.dataset.rowsKey !== undefined
        ? root && typeof root === "object" && Object.hasOwn(root, panel.dataset.rowsKey)
          ? (root as Record<string, unknown>)[panel.dataset.rowsKey]
          : undefined
        : root;
    if (Array.isArray(rows)) records = rows as Array<Record<string, unknown>>;
    else if (!panel.dataset.rowsKey && root && typeof root === "object") records = [root as Record<string, unknown>];
    else throw new Error("Table rows were not found in the data.");
  }
  if (records.length > REPORT_LIMITS.maxTableRows) throw new Error("Table has too many rows.");
  return records;
}

function cell(row: Record<string, unknown>, field: string): string {
  const v = Object.hasOwn(row, field) ? row[field] : undefined;
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const CHART = { width: 560, height: 260, left: 48, right: 12, top: 12, bottom: 38 } as const;
const MAX_CHART_MARKERS = 1500;

/** A line chart drawn as plain SVG from the panel's own dataset; no network, no chart library. */
function LineChart({ records, chart }: { records: Array<Record<string, unknown>>; chart: Exclude<ChartSpec, { type: "heatmap" }> }) {
  const layout = useMemo(() => lineChartLayout(records, { x: chart.x.field, y: chart.y.field, seriesField: chart.seriesField }), [records, chart]);
  const { width, height, left, right, top, bottom } = CHART;
  const [x0, x1] = layout.xDomain;
  const [y0, y1] = layout.yDomain;
  const sx = (v: number) => left + ((v - x0) / (x1 - x0)) * (width - left - right);
  const sy = (v: number) => height - bottom - ((v - y0) / (y1 - y0)) * (height - top - bottom);
  const points = layout.series.reduce((n, s) => n + s.points.length, 0);
  const unit = (c: Column) => (c.unit ? ` ${c.unit}` : "");
  if (points === 0) return <p className="md-muted">No numeric data to plot.</p>;
  return (
    <figure className="md-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${chart.y.label} by ${chart.x.label}`} data-testid="line-chart">
        {layout.yTicks.map((t) => (
          <g key={`y${t}`}>
            <line className="md-grid" x1={left} x2={width - right} y1={sy(t)} y2={sy(t)} />
            <text className="md-tick" x={left - 6} y={sy(t)} textAnchor="end" dominantBaseline="middle">{t}</text>
          </g>
        ))}
        {layout.xTicks.map((t) => (
          <text key={`x${t}`} className="md-tick" x={sx(t)} y={height - bottom + 14} textAnchor="middle">{t}</text>
        ))}
        <line className="md-axis" x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} />
        <line className="md-axis" x1={left} x2={left} y1={top} y2={height - bottom} />
        <text className="md-tick" x={(left + width - right) / 2} y={height - 4} textAnchor="middle">{chart.x.label}{unit(chart.x)}</text>
        <text className="md-tick" transform={`translate(12 ${(top + height - bottom) / 2}) rotate(-90)`} textAnchor="middle">{chart.y.label}{unit(chart.y)}</text>
        {layout.series.map((s, i) => (
          <g key={s.name} className={`md-series md-series-${i % 6}`} data-series={s.name}>
            <polyline points={s.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ")} />
            {points <= MAX_CHART_MARKERS &&
              s.points.map((p) => (
                <circle key={p.x} cx={sx(p.x)} cy={sy(p.y)} r={2.5}>
                  <title>{`${s.name ? `${s.name}: ` : ""}${chart.x.label} ${p.x}, ${chart.y.label} ${p.y}${unit(chart.y)}`}</title>
                </circle>
              ))}
          </g>
        ))}
      </svg>
      {layout.series.length > 1 && (
        <figcaption className="md-legend">
          {layout.series.map((s, i) => (
            <span key={s.name} className={`md-series md-series-${i % 6}`}><i />{s.name}</span>
          ))}
        </figcaption>
      )}
      {layout.skipped > 0 && <p className="md-muted">{layout.skipped} rows without numbers were not plotted.</p>}
    </figure>
  );
}

function DataPanel({ panel, loaded }: { panel: Extract<Panel, { kind: "table" | "chart" }>; loaded: Loaded }) {
  const view = useMemo(() => {
    try {
      const records = rowsFor(panel, loaded);
      const columns =
        panel.kind === "table"
          ? panel.columns
          : panel.chart.type === "heatmap"
            ? [panel.chart.x, panel.chart.y, panel.chart.value]
            : [panel.chart.x, panel.chart.y, ...(panel.chart.seriesField ? [{ field: panel.chart.seriesField, label: panel.chart.seriesField }] : [])];
      const fields: Column[] = columns.length > 0 ? columns : Object.keys(records[0] ?? {}).map((f) => ({ field: f, label: f }));
      return { records, fields, error: undefined as string | undefined };
    } catch (e) {
      return { records: [], fields: [], error: e instanceof Error ? e.message : "Could not read this table." };
    }
  }, [panel, loaded]);
  const shown = view.records.slice(0, 500);
  const line = panel.kind === "chart" && panel.chart.type === "line" ? panel.chart : undefined;
  const table = (
        <div className="md-table-wrap">
          <table>
            <thead>
              <tr>{view.fields.map((c) => <th key={c.field}>{c.label}{c.unit ? ` (${c.unit})` : ""}</th>)}</tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={i}>{view.fields.map((c) => <td key={c.field}>{cell(row, c.field)}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {view.records.length > shown.length && <p className="md-muted">Showing the first {shown.length} of {view.records.length} rows.</p>}
        </div>
  );
  return (
    <section className="md-panel">
      <h3>{panel.title ?? (panel.kind === "chart" ? "Chart data" : "Results")}</h3>
      {panel.kind === "chart" && !line && <p className="md-muted">This chart type is not drawn yet; showing the data table.</p>}
      {view.error ? (
        <p className="md-error" role="alert">{view.error}</p>
      ) : line ? (
        <>
          <LineChart records={view.records} chart={line} />
          <details className="md-chart-data">
            <summary>Data table</summary>
            {table}
          </details>
        </>
      ) : (
        table
      )}
    </section>
  );
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

const LINKS = [
  { label: "Website", href: "https://moleculedesk.com/" },
  { label: "Docs", href: "https://www.moleculedesk.com/docs" },
  { label: "GitHub", href: "https://github.com/pooriyapfn/moldesk" },
] as const;

function Footer({ envelope }: { envelope?: Envelope }) {
  const [about, setAbout] = useState(false);
  return (
    <footer className="md-footer">
      {about && (
        <div className="md-about md-glass" role="note">
          Report viewer {envelope?.viewer.version} · works offline
          <br />
          3D rendering by Mol* {envelope?.viewer.molstarVersion} (MIT License, © Mol* contributors)
        </div>
      )}
      <div className="md-footer-main md-glass">
        <strong>MoleculeDesk</strong>
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>
        ))}
        <button className="md-link" aria-expanded={about} onClick={() => setAbout(!about)}>About</button>
      </div>
    </footer>
  );
}

const GROUP = 10;

const SequenceRows = memo(function SequenceRows({ rows }: { rows: SequenceRow[] }) {
  return (
    <>
      {rows.map((row) => {
        const groups: SequenceRow["residues"][] = [];
        for (let i = 0; i < row.residues.length; i += GROUP) groups.push(row.residues.slice(i, i + GROUP));
        return (
          <div className="md-seq-row" key={row.key} data-row={row.key}>
            <span className="md-seq-chain">{row.label}</span>
            {groups.map((g, gi) => (
              <span className="md-seq-group" key={gi} data-count={g.length === GROUP ? (gi + 1) * GROUP : undefined}>
                {g.map((r, ri) => {
                  const i = gi * GROUP + ri;
                  return (
                    <span
                      key={ri}
                      className={`md-res${r.modeled ? "" : " md-res-missing"}${r.modified ? " md-res-mod" : ""}${r.letter.length > 1 ? " md-res-long" : ""}`}
                      data-row={row.key}
                      data-i={i}
                      data-seqid={r.seqId}
                      data-comp={r.comp}
                      data-title={r.title}
                      style={r.color ? { color: r.color } : undefined}
                    >
                      {r.letter}
                    </span>
                  );
                })}
              </span>
            ))}
          </div>
        );
      })}
    </>
  );
});

function SequencePanel({ summary, viewer }: { summary: SceneSummary; viewer: Viewer }) {
  const [info, setInfo] = useState("");
  const target = (e: { target: EventTarget }) => (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  return (
    <div
      className="md-seq"
      data-testid="sequence"
      onMouseOver={(e) => {
        const el = target(e);
        if (!el) return;
        viewer.highlight(el.dataset.row, Number(el.dataset.i));
        setInfo(el.dataset.title ?? "");
      }}
      onMouseLeave={() => {
        viewer.highlight();
        setInfo("");
      }}
      onClick={(e) => {
        const el = target(e);
        if (el?.dataset.row) viewer.toggleSelect(el.dataset.row, Number(el.dataset.i));
      }}
    >
      <div className="md-seq-scroll">
        <SequenceRows rows={summary.sequences} />
      </div>
      <div className="md-seq-info" data-testid="residue-info" aria-live="polite">
        {info}
        {!info && summary.sequenceRowsOmitted > 0 ? `${summary.sequenceRowsOmitted} more chains not shown` : ""}
      </div>
    </div>
  );
}

function StructureView({
  scenes,
  loaded,
  title,
  onUpdate,
}: {
  scenes: Scene[];
  loaded: Loaded;
  title: string;
  onUpdate: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [ready, setReady] = useState(false);
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? "");
  const [representation, setRepresentation] = useState<RepresentationKind>("cartoon");
  const [showLigands, setShowLigands] = useState(true);
  const [showWater, setShowWater] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showData, setShowData] = useState(false);
  const [summary, setSummary] = useState<SceneSummary>();
  const [error, setError] = useState<string>();
  const [gl] = useState(webglAvailable);
  const dataPanels = loaded.report.panels.filter((p): p is Extract<Panel, { kind: "table" | "chart" }> => p.kind === "table" || p.kind === "chart");

  useEffect(() => {
    if (!gl || !host.current) return;
    let cancelled = false;
    Viewer.create(host.current)
      .then((v) => {
        if (cancelled) return v.dispose();
        viewer.current = v;
        v.setBackground("#000000");
        setReady(true);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "The viewer could not start."));
    return () => {
      cancelled = true;
      viewer.current?.dispose();
      viewer.current = null;
    };
  }, [gl]);

  const scene = scenes.find((s) => s.id === sceneId);
  useEffect(() => {
    if (!ready || !scene || !viewer.current) return;
    let cancelled = false;
    setError(undefined);
    viewer.current
      .loadScene(scene, loaded.resources, { representation, showLigands, showWater })
      .then((s) => !cancelled && setSummary(s))
      .catch((e) => !cancelled && setError(`This structure could not be displayed: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [ready, scene, loaded, representation, showLigands, showWater]);

  const savePng = useCallback(async () => {
    try {
      const uri = await viewer.current!.exportPng();
      const a = document.createElement("a");
      a.href = uri;
      a.download = `${(scene?.title ?? "structure").replace(/[^\w.-]+/g, "_")}.png`;
      a.click();
    } catch (e) {
      setError(`Could not export an image: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [scene]);

  return (
    <div className="md-stage">
      {gl && (
        <div
          ref={host}
          className="md-viewport"
          data-testid="viewport"
          data-loaded-scene={summary?.sceneId}
          data-structure-count={summary?.structureCount}
        />
      )}
      <div className="md-overlay">
        {summary && viewer.current && summary.sequences.length > 0 && <SequencePanel summary={summary} viewer={viewer.current} />}
        <div className="md-mid">
          <aside className={`md-toolbox md-glass${collapsed ? " md-collapsed" : ""}`} aria-label="Toolbox">
            <div className="md-tool-head">
              <h1 title={title}>{title}</h1>
              <button className="md-icon" aria-label={collapsed ? "Expand toolbox" : "Collapse toolbox"} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
                {collapsed ? "›" : "‹"}
              </button>
            </div>
            {!collapsed && (
              <div className="md-tool-body">
                {scenes.length > 1 && (
                  <label className="md-field">
                    <span>Prediction</span>
                    <select value={sceneId} onChange={(e) => setSceneId(e.target.value)} aria-label="Scene">
                      {scenes.map((s) => (
                        <option key={s.id} value={s.id}>{s.rank ? `#${s.rank} · ` : ""}{s.title}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="md-field">
                  <span>Style</span>
                  <select value={representation} onChange={(e) => setRepresentation(e.target.value as RepresentationKind)}>
                    <option value="cartoon">Cartoon</option>
                    <option value="sticks">Sticks</option>
                    <option value="surface">Surface</option>
                  </select>
                </label>
                <label className="md-check"><input type="checkbox" checked={showLigands} onChange={(e) => setShowLigands(e.target.checked)} /> Ligands</label>
                <label className="md-check"><input type="checkbox" checked={showWater} onChange={(e) => setShowWater(e.target.checked)} /> Water</label>
                <div className="md-row">
                  <button onClick={() => viewer.current?.resetCamera()}>Fit</button>
                  <button onClick={savePng} disabled={!gl}>Save image</button>
                </div>
                {dataPanels.length > 0 && (
                  <button aria-expanded={showData} onClick={() => setShowData(!showData)}>{showData ? "Hide results" : "Results"}</button>
                )}
                <button onClick={onUpdate}>Update viewer</button>
                {summary && !summary.hasPolymerSequence && <p className="md-muted">No polymer sequence in this structure.</p>}
                {summary && summary.modelCount > 1 && (
                  <p className="md-muted">This file has {summary.modelCount} models; showing model 1.</p>
                )}
              </div>
            )}
          </aside>
          {showData && (
            <section className="md-data md-glass" aria-label="Results">
              {dataPanels.map((p) => <DataPanel key={p.id} panel={p} loaded={loaded} />)}
            </section>
          )}
        </div>
        {!gl && (
          <p className="md-error md-center md-glass" role="alert">
            3D graphics (WebGL) are not available in this browser. Try another browser or enable hardware acceleration in its settings.
          </p>
        )}
        {error && <p className="md-error md-center md-glass" role="alert">{error}</p>}
        <Footer envelope={loaded.envelope} />
      </div>
    </div>
  );
}

function App() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [showUpdate, setShowUpdate] = useState(false);

  useEffect(() => {
    loadReport().then(setLoaded, (e) => setError(e instanceof Error ? e.message : "This report could not be opened."));
  }, []);

  useEffect(() => {
    if (loaded) document.title = loaded.report.title;
  }, [loaded]);

  const structurePanel = loaded?.report.panels.find((p) => p.kind === "structure");
  const scenes = useMemo(() => {
    if (!loaded) return [];
    const ids = structurePanel?.kind === "structure" ? structurePanel.sceneIds : loaded.report.scenes.map((s) => s.id);
    return ids.flatMap((id) => loaded.report.scenes.filter((s) => s.id === id));
  }, [loaded, structurePanel]);

  const title = loaded?.report.title ?? "MoleculeDesk report";
  return (
    <div className="md-app">
      {error && <p className="md-error md-center md-glass" role="alert">{error}</p>}
      {loaded && scenes.length > 0 && <StructureView scenes={scenes} loaded={loaded} title={title} onUpdate={() => setShowUpdate(true)} />}
      {loaded && scenes.length === 0 && (
        <main className="md-plain">
          <header>
            <h1>{title}</h1>
            <button onClick={() => setShowUpdate(true)}>Update viewer</button>
          </header>
          {loaded.report.panels.map((p) =>
            p.kind === "table" || p.kind === "chart" ? <DataPanel key={p.id} panel={p} loaded={loaded} /> : null,
          )}
          <Footer envelope={loaded.envelope} />
        </main>
      )}
      {!loaded && !error && <Footer />}
      {showUpdate && <UpdateModal onClose={() => setShowUpdate(false)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

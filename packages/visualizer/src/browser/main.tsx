import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isMolecularFormat, validateReport, type Column, type MolecularReportV1, type Panel, type Scene } from "../contract";
import { csvRecords, parseCsv } from "../csv";
import { REPORT_LIMITS } from "../limits";
import { Viewer, type LoadedResource, type RepresentationKind, type SceneSummary } from "./molstar";
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
  return (
    <section className="md-panel">
      <h3>{panel.title ?? (panel.kind === "chart" ? "Chart data" : "Results")}</h3>
      {panel.kind === "chart" && <p className="md-muted">Chart rendering is not available yet; showing the data table.</p>}
      {view.error ? (
        <p className="md-error" role="alert">{view.error}</p>
      ) : (
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

function StructureView({ scenes, loaded }: { scenes: Scene[]; loaded: Loaded }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [ready, setReady] = useState(false);
  const [sceneId, setSceneId] = useState(scenes[0]?.id ?? "");
  const [representation, setRepresentation] = useState<RepresentationKind>("cartoon");
  const [showLigands, setShowLigands] = useState(true);
  const [showWater, setShowWater] = useState(false);
  const [dark, setDark] = useState(false);
  const [summary, setSummary] = useState<SceneSummary>();
  const [error, setError] = useState<string>();
  const [gl] = useState(webglAvailable);

  useEffect(() => {
    if (!gl || !host.current) return;
    let cancelled = false;
    Viewer.create(host.current)
      .then((v) => {
        if (cancelled) return v.dispose();
        viewer.current = v;
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

  useEffect(() => {
    if (ready) viewer.current?.setBackground(dark ? "#1b1d21" : "#ffffff");
  }, [ready, dark, scene]);

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

  if (!gl) {
    return (
      <p className="md-error" role="alert">
        3D graphics (WebGL) are not available in this browser. Try another browser or enable hardware acceleration in its settings.
      </p>
    );
  }
  return (
    <section className="md-structure">
      <div className="md-toolbar">
        {scenes.length > 1 && (
          <label>
            Prediction
            <select value={sceneId} onChange={(e) => setSceneId(e.target.value)} aria-label="Scene">
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>{s.rank ? `#${s.rank} · ` : ""}{s.title}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Style
          <select value={representation} onChange={(e) => setRepresentation(e.target.value as RepresentationKind)}>
            <option value="cartoon">Cartoon</option>
            <option value="sticks">Sticks</option>
            <option value="surface">Surface</option>
          </select>
        </label>
        <label><input type="checkbox" checked={showLigands} onChange={(e) => setShowLigands(e.target.checked)} /> Ligands</label>
        <label><input type="checkbox" checked={showWater} onChange={(e) => setShowWater(e.target.checked)} /> Water</label>
        <label><input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> Dark background</label>
        <button onClick={() => viewer.current?.resetCamera()}>Fit</button>
        <button onClick={savePng}>Save image</button>
      </div>
      {summary && !summary.hasPolymerSequence && <p className="md-muted">No polymer sequence in this structure.</p>}
      {summary && summary.modelCount > 1 && (
        <p className="md-muted">This file has {summary.modelCount} models; showing model 1.</p>
      )}
      {error && <p className="md-error" role="alert">{error}</p>}
      <div
        ref={host}
        className="md-viewport"
        data-testid="viewport"
        data-loaded-scene={summary?.sceneId}
        data-structure-count={summary?.structureCount}
      />
    </section>
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

  return (
    <div className="md-app">
      <header className="md-header">
        <h1>{loaded?.report.title ?? "MoleculeDesk report"}</h1>
        <button onClick={() => setShowUpdate(true)}>Update viewer</button>
      </header>
      {error && <p className="md-error" role="alert">{error}</p>}
      {loaded && (
        <main>
          {scenes.length > 0 && <StructureView scenes={scenes} loaded={loaded} />}
          {loaded.report.panels.map((p) =>
            p.kind === "table" || p.kind === "chart" ? <DataPanel key={p.id} panel={p} loaded={loaded} /> : null,
          )}
        </main>
      )}
      <footer className="md-footer">
        Viewer {loaded?.envelope.viewer.version} · Structure viewer powered by Mol* {loaded?.envelope.viewer.molstarVersion} (MIT License, © Mol* contributors) · works offline
      </footer>
      {showUpdate && <UpdateModal onClose={() => setShowUpdate(false)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

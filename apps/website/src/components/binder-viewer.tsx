"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import results from "@/lib/rfd4-pdl1-results.json";

type Vec = [number, number, number];

type Design = {
  id: string;
  length: number;
  seq: string;
  ca: Vec[];
  contactBinder: number[];
  contactTarget: number[];
  hotspotMin: number;
  hotspotMax: number;
  closest: number;
  tight: boolean;
};

type Data = {
  source: string;
  target: {
    ca: Vec[];
    hotspotResidues: number[];
    hotspotAtoms: { res: number; atom: string; xyz: Vec }[];
  };
  designs: Design[];
};

const data = results as unknown as Data;

// Bright, saturated colours so the cartoons stay vivid under Mol*'s lighting; the eight binders differ in hue and lightness.
const COLORS = ["#1E90FF", "#FF8A00", "#00C27A", "#E066FF", "#FFC800", "#2FD4FF", "#8F7CFF", "#A6E22E"];
const TARGET = "#C9D6DF";
const TARGET_CONTACT = "#4b5753";
const HOTSPOT = "#FF1493";

// Hotspot residue numbers in the original PDB 5O45 numbering (the output renumbers the target 1-115).
const HOTSPOT_LABELS = ["Tyr56", "Met115", "Tyr123"];

type Prim = { z: number; draw: (ctx: CanvasRenderingContext2D) => void };

// The prebuilt Mol* viewer (copied to /vendor/molstar by scripts/sync-molstar.mjs) is a 5 MB script, so it is
// fetched only when the viewer scrolls into view. Only the few members used here are typed.
interface MolstarStructureRef {
  cell: { state: { isHidden?: boolean } };
  model?: { trajectory?: { cell?: { obj?: { label?: string } } } };
}
interface MolstarPlugin {
  dispose(): void;
  managers: {
    camera: { reset(): void };
    structure: {
      hierarchy: {
        current: { structures: MolstarStructureRef[] };
        toggleVisibility(refs: MolstarStructureRef[], action?: "show" | "hide"): void;
      };
    };
  };
  canvas3d?: { setProps(props: Record<string, unknown>): void };
}
interface MolstarViewer {
  plugin: MolstarPlugin;
  loadStructureFromUrl(url: string, format: string, isBinary: boolean, options?: Record<string, unknown>): Promise<void>;
}
interface MolstarGlobal {
  Viewer: { create(element: HTMLElement, options: Record<string, unknown>): Promise<MolstarViewer> };
}

const MOLSTAR_BASE = "/vendor/molstar";
const DATA_BASE = "/data/rfd4-pdl1";
let molstarLoad: Promise<MolstarGlobal> | null = null;

function loadMolstar(): Promise<MolstarGlobal> {
  const existing = (window as unknown as { molstar?: MolstarGlobal }).molstar;
  if (existing) return Promise.resolve(existing);
  if (molstarLoad) return molstarLoad;
  molstarLoad = new Promise<MolstarGlobal>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${MOLSTAR_BASE}/light.css`;
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = `${MOLSTAR_BASE}/molstar.js`;
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { molstar?: MolstarGlobal }).molstar;
      if (api) resolve(api);
      else reject(new Error("Mol* loaded but did not expose a viewer"));
    };
    script.onerror = () => reject(new Error("Mol* could not be loaded"));
    document.head.appendChild(script);
  }).catch((error) => {
    molstarLoad = null;
    throw error;
  });
  return molstarLoad;
}

const hexToNumber = (hex: string) => parseInt(hex.slice(1), 16);

function rotate(p: Vec, yaw: number, pitch: number): Vec {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x1 = p[0] * cy + p[2] * sy;
  const z1 = -p[0] * sy + p[2] * cy;
  const y2 = p[1] * cp - z1 * sp;
  const z2 = p[1] * sp + z1 * cp;
  return [x1, y2, z2];
}

export function BinderViewer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<number | "all">(0);
  const [showContacts, setShowContacts] = useState(true);
  // "pending": the cartoon view is on its way (a calm placeholder is shown, never the fallback trace).
  const [engine, setEngine] = useState<"pending" | "molstar" | "canvas">("pending");
  const [revealed, setRevealed] = useState(false);
  const [cartoonFailed, setCartoonFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const molstarEl = useRef<HTMLDivElement | null>(null);
  const molstarViewer = useRef<MolstarViewer | null>(null);
  const view = useRef({ yaw: 0.6, pitch: -0.35, size: { w: 640, h: 440 } });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const shown = useMemo(
    () => (selected === "all" ? data.designs.map((_, i) => i) : [selected]),
    [selected],
  );

  // The view is fitted to whatever is on screen: the target plus the selected binder(s).
  const geometry = useMemo(() => {
    const pts: Vec[] = [...data.target.ca, ...shown.flatMap((i) => data.designs[i].ca)];
    const lo: Vec = [Infinity, Infinity, Infinity];
    const hi: Vec = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) {
      for (let k = 0; k < 3; k += 1) {
        lo[k] = Math.min(lo[k], p[k]);
        hi[k] = Math.max(hi[k], p[k]);
      }
    }
    const c: Vec = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    let radius = 1;
    for (const p of pts) radius = Math.max(radius, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
    return { center: c, radius };
  }, [shown]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = view.current.size;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { yaw, pitch } = view.current;
    const scale = (Math.min(w, h) / 2 / geometry.radius) * 0.96;
    const project = (p: Vec) => {
      const r = rotate([p[0] - geometry.center[0], p[1] - geometry.center[1], p[2] - geometry.center[2]], yaw, pitch);
      const persp = 1 + (r[2] / geometry.radius) * 0.12;
      return { x: w / 2 + r[0] * scale * persp, y: h / 2 - r[1] * scale * persp, z: r[2] };
    };
    const depthAlpha = (z: number) => 0.35 + 0.65 * (1 - (z / geometry.radius + 1) / 2);

    const prims: Prim[] = [];
    const trace = (pts: Vec[], color: string, width: number, alphaScale: number) => {
      const q = pts.map(project);
      for (let i = 0; i < q.length - 1; i += 1) {
        const a = q[i];
        const b = q[i + 1];
        prims.push({
          z: (a.z + b.z) / 2,
          draw: (c) => {
            c.globalAlpha = depthAlpha((a.z + b.z) / 2) * alphaScale;
            c.strokeStyle = color;
            c.lineWidth = width;
            c.lineCap = "round";
            c.beginPath();
            c.moveTo(a.x, a.y);
            c.lineTo(b.x, b.y);
            c.stroke();
          },
        });
      }
    };
    const dot = (p: Vec, color: string, radius: number, outline: boolean) => {
      const q = project(p);
      prims.push({
        z: q.z + 0.001,
        draw: (c) => {
          c.globalAlpha = 1;
          c.fillStyle = color;
          c.beginPath();
          c.arc(q.x, q.y, radius, 0, Math.PI * 2);
          c.fill();
          if (outline) {
            c.strokeStyle = "#ffffff";
            c.lineWidth = 1.5;
            c.stroke();
          }
        },
      });
    };

    trace(data.target.ca, TARGET, 2.2, 1);
    const targetContacts = new Set<number>();
    for (const i of shown) {
      const d = data.designs[i];
      trace(d.ca, COLORS[i], selected === "all" ? 1.4 : 3, selected === "all" ? 0.8 : 1);
      if (showContacts) {
        for (const k of d.contactBinder) dot(d.ca[k], COLORS[i], selected === "all" ? 2.2 : 3.2, false);
        for (const k of d.contactTarget) targetContacts.add(k);
      }
    }
    for (const k of targetContacts) dot(data.target.ca[k], TARGET_CONTACT, 2.6, false);
    for (const res of data.target.hotspotResidues) dot(data.target.ca[res - 1], HOTSPOT, 6.5, true);
    for (const atom of data.target.hotspotAtoms) dot(atom.xyz, HOTSPOT, 2, false);

    prims.sort((a, b) => b.z - a.z);
    for (const p of prims) p.draw(ctx);
    ctx.globalAlpha = 1;

    // Hotspot labels sit on top of everything else.
    ctx.font = "12px var(--font-ibm-plex-sans), system-ui, sans-serif";
    ctx.fillStyle = HOTSPOT;
    data.target.hotspotResidues.forEach((res, n) => {
      const q = project(data.target.ca[res - 1]);
      ctx.fillText(HOTSPOT_LABELS[n] ?? `res ${res}`, q.x + 10, q.y - 10 - n * 13);
    });
  }, [geometry, selected, shown, showContacts]);

  // Redraw whenever the canvas size or the displayed state changes.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const resize = () => {
      const w = Math.max(280, wrap.clientWidth);
      view.current.size = { w, h: Math.round(Math.min(480, Math.max(320, w * 0.68))) };
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.width = `${view.current.size.w}px`;
        canvas.style.height = `${view.current.size.h}px`;
      }
      draw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw]);

  // Mol* cartoon view: start loading once the viewer is near the screen (unless the visitor saves data).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || molstarViewer.current) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const connection = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
        if (connection?.saveData) {
          setEngine("canvas");
          return;
        }
        loadMolstar()
          .then(async (api) => {
            if (cancelled || !molstarEl.current) return;
            const viewer = await api.Viewer.create(molstarEl.current, {
              layoutIsExpanded: false,
              layoutShowControls: false,
              layoutShowRemoteState: false,
              layoutShowSequence: false,
              layoutShowLog: false,
              layoutShowLeftPanel: false,
              viewportShowReset: false,
              viewportShowControls: false,
              viewportShowExpand: false,
              viewportShowToggleFullscreen: false,
              viewportShowSelectionMode: false,
              viewportShowAnimation: false,
              viewportShowSettings: false,
              viewportShowScreenshotControls: false,
              viewportBackgroundColor: "#ffffff",
              pdbProvider: "pdbe",
              emdbProvider: "pdbe",
            });
            if (cancelled) {
              viewer.plugin.dispose();
              return;
            }
            // No orientation gizmo in the corner: the page's own buttons are the only controls.
            viewer.plugin.canvas3d?.setProps({ camera: { helper: { axes: { name: "off", params: {} } } } });
            // Load every structure once; choosing a design later only shows or hides them, so nothing flickers.
            const uniform = (hex: string, label: string) => ({
              label,
              representationParams: { theme: { globalName: "uniform", globalColorParams: { value: hexToNumber(hex) } } },
            });
            await viewer.loadStructureFromUrl(`${DATA_BASE}/target.pdb`, "pdb", false, uniform(TARGET, "PD-L1"));
            await viewer.loadStructureFromUrl(`${DATA_BASE}/hotspots.pdb`, "pdb", false, uniform(HOTSPOT, "hotspot atoms"));
            for (let i = 0; i < data.designs.length; i += 1) {
              await viewer.loadStructureFromUrl(`${DATA_BASE}/binder_${i}.pdb`, "pdb", false, uniform(COLORS[i], `binder_${i}`));
              if (cancelled) {
                viewer.plugin.dispose();
                return;
              }
            }
            molstarViewer.current = viewer;
            setEngine("molstar");
          })
          .catch(() => {
            if (cancelled) return;
            setEngine("canvas");
            setCartoonFailed(true);
          });
      },
      { rootMargin: "300px" },
    );
    observer.observe(stage);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      molstarViewer.current?.plugin.dispose();
      molstarViewer.current = null;
    },
    [],
  );

  // Show only the chosen designs. The first time, the camera is framed on what is visible and the scene fades in.
  useEffect(() => {
    const viewer = molstarViewer.current;
    if (engine !== "molstar" || !viewer) return;
    const hierarchy = viewer.plugin.managers.structure.hierarchy;
    const wanted = new Set(["PD-L1", "hotspot atoms", ...shown.map((i) => `binder_${i}`)]);
    const toHide: MolstarStructureRef[] = [];
    const toShow: MolstarStructureRef[] = [];
    for (const structure of hierarchy.current.structures) {
      const label = structure.model?.trajectory?.cell?.obj?.label ?? "";
      const hidden = structure.cell.state.isHidden === true;
      if (wanted.has(label) && hidden) toShow.push(structure);
      if (!wanted.has(label) && !hidden) toHide.push(structure);
    }
    if (toHide.length > 0) hierarchy.toggleVisibility(toHide, "hide");
    if (toShow.length > 0) hierarchy.toggleVisibility(toShow, "show");
    if (!revealed) {
      viewer.plugin.managers.camera.reset();
      // A short timer (not requestAnimationFrame, which background tabs pause) lets Mol* paint its first frame.
      const timer = setTimeout(() => setRevealed(true), 150);
      return () => clearTimeout(timer);
    }
  }, [engine, shown, revealed]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    view.current.yaw += (e.clientX - drag.current.x) * 0.01;
    view.current.pitch = Math.max(-1.4, Math.min(1.4, view.current.pitch + (e.clientY - drag.current.y) * 0.01));
    drag.current = { x: e.clientX, y: e.clientY };
    draw();
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const d = selected === "all" ? null : data.designs[selected];
  const btn = (active: boolean) =>
    `rounded-md border px-2.5 py-1 font-mono text-[12px] ${
      active ? "border-accent bg-accent-soft text-foreground" : "border-border bg-white text-muted hover:text-foreground"
    }`;

  return (
    <figure className="not-prose my-6">
      <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Choose which binder designs to show">
        <button type="button" className={btn(selected === "all")} aria-pressed={selected === "all"} onClick={() => setSelected("all")}>
          All 8
        </button>
        {data.designs.map((design, i) => (
          <button
            key={design.id}
            type="button"
            className={btn(selected === i)}
            aria-pressed={selected === i}
            onClick={() => setSelected(i)}
          >
            <span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: COLORS[i] }} />
            {i}
          </button>
        ))}
      </div>

      <div ref={stageRef} className="relative overflow-hidden rounded-md border border-border bg-white">
      <div ref={wrapRef} className={engine === "canvas" ? undefined : "invisible"}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Interactive 3D view of eight RFD4-Proteina binder designs around PD-L1. Drag to rotate."
          className="block touch-none cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
        {/* Mol* mounts here as soon as its script is ready and fades in once the first scene is complete. */}
        <div
          ref={molstarEl}
          className={`absolute inset-0 transition-opacity duration-300 ${revealed ? "opacity-100" : "pointer-events-none opacity-0"}`}
          aria-hidden={!revealed}
        />
        {engine !== "canvas" && !revealed ? (
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-[13px] text-muted">
            Loading the 3D cartoon view (Mol*, about 5 MB)…
          </p>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
        {engine !== "canvas" ? null : (
          <button type="button" className={btn(showContacts)} aria-pressed={showContacts} onClick={() => setShowContacts((v) => !v)}>
            Contact residues
          </button>
        )}
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-0.5 w-4" style={{ background: TARGET }} />PD-L1</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HOTSPOT }} />hotspot atoms (Tyr56, Met115, Tyr123)</span>
        </span>
      </div>

      <figcaption className="mt-2 space-y-1 text-[13px] text-muted">
        {d ? (
          <p aria-live="polite">
            <strong className="text-foreground">{d.id}</strong>: {d.length} residues, {d.contactBinder.length} binder residues within 4.5 Å of PD-L1, every hotspot atom
            within {d.hotspotMax.toFixed(1)} Å (closest {d.hotspotMin.toFixed(1)} Å), closest binder-target atom pair {d.closest.toFixed(2)} Å
            {d.tight ? " (too tight: below 2.2 Å)" : ""}.
          </p>
        ) : (
          <p aria-live="polite">
            All eight binders are superimposed on the same PD-L1 (the target backbone differs by about 0.1 Å between designs). Pick a number to look at one design.
          </p>
        )}
        <p>
          {engine !== "canvas" ? (
            <>Drag to rotate, scroll to zoom. Cartoon view rendered with Mol* from the backbone atoms of the real output structures (helices and strands are assigned by Mol*, not by the design model).</>
          ) : cartoonFailed ? (
            <>The 3D cartoon view could not be loaded, so this is a backbone (Cα) trace of the real output coordinates. Drag to rotate.</>
          ) : (
            <>Showing a lightweight backbone (Cα) trace of the real output coordinates; the 3D cartoon view is skipped when data saver is on. Drag to rotate.</>
          )}{" "}
          The full report that <code>moldesk run</code> opens on your machine has more.
        </p>
      </figcaption>
    </figure>
  );
}

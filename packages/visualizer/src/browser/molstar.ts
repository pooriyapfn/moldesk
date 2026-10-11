// Thin bridge over Mol*: offline plugin setup, scene loading from embedded bytes,
// selections, representations, and PNG export. No report/model-specific logic here.

import { createPluginUI } from "molstar/lib/mol-plugin-ui";
import { renderReact18 } from "molstar/lib/mol-plugin-ui/react18";
import type { PluginUIContext } from "molstar/lib/mol-plugin-ui/context";
import { DefaultPluginUISpec, type PluginUISpec } from "molstar/lib/mol-plugin-ui/spec";
import { PluginConfig } from "molstar/lib/mol-plugin/config";
import { PluginCommands } from "molstar/lib/mol-plugin/commands";
import { StateActions } from "molstar/lib/mol-plugin-state/actions";
import { StateTransforms } from "molstar/lib/mol-plugin-state/transforms";
import {
  BoxifyVolumeStreaming,
  CreateVolumeStreamingBehavior,
  InitVolumeStreaming,
} from "molstar/lib/mol-plugin/behavior/dynamic/volume-streaming/transformers";
import { PluginBehaviors } from "molstar/lib/mol-plugin/behavior";
import { StructureSelectionQueries } from "molstar/lib/mol-plugin-state/helpers/structure-selection-query";
import { MolScriptBuilder as MS } from "molstar/lib/mol-script/language/builder";
import type { Expression } from "molstar/lib/mol-script/language/expression";
import { Color } from "molstar/lib/mol-util/color";
import { Mat4 } from "molstar/lib/mol-math/linear-algebra";
import type { StateObjectSelector } from "molstar/lib/mol-state";
import { Unit, StructureElement, type Structure, type ElementIndex } from "molstar/lib/mol-model/structure";
import { SortedArray } from "molstar/lib/mol-data/int";
import { PluginStateObject } from "molstar/lib/mol-plugin-state/objects";
import type { Scene, SceneComponent, MolecularSelection, MolecularFormat } from "../contract";

export interface LoadedResource {
  format: MolecularFormat;
  bytes: Uint8Array;
}

export type RepresentationKind = "cartoon" | "sticks" | "surface";

export interface SceneOptions {
  representation: RepresentationKind;
  showLigands: boolean;
  showWater: boolean;
}

export interface SequenceResidue {
  /** One-letter code, or the three-letter component name when there is no one-letter code. */
  letter: string;
  seqId: number;
  /** Component actually present in the structure (e.g. MSE for a displayed M). */
  comp: string;
  title: string;
  /** `#rrggbb` taken from the structure's own color theme; undefined when not modeled. */
  color?: string;
  modeled: boolean;
  modified: boolean;
}

export interface SequenceRow {
  key: string;
  label: string;
  residues: SequenceResidue[];
}

export interface SceneSummary {
  sceneId: string;
  structureCount: number;
  hasPolymerSequence: boolean;
  modelCount: number;
  sequences: SequenceRow[];
  sequenceRowsOmitted: number;
}

const MAX_SEQUENCE_ROWS = 24;

const NETWORK_ACTIONS = new Set<unknown>([
  StateActions.Structure.DownloadStructure,
  StateActions.Volume.DownloadDensity,
  StateActions.DataFormat.DownloadFile,
  InitVolumeStreaming,
  BoxifyVolumeStreaming,
  CreateVolumeStreamingBehavior,
  StateTransforms.Data.Download,
]);

// Dropped: SIFTS mapping fetches from PDBe; everything else listed here is purely local.
const BLOCKED_BEHAVIORS = new Set<unknown>([PluginBehaviors.CustomProps.BestDatabaseSequenceMapping]);

function offlineSpec(): PluginUISpec {
  const base = DefaultPluginUISpec();
  return {
    ...base,
    actions: (base.actions ?? []).filter((a) => !NETWORK_ACTIONS.has(a.action)),
    behaviors: base.behaviors.filter((b) => !BLOCKED_BEHAVIORS.has(b.transformer)),
    customParamEditors: [],
    components: {
      // Not just hidden: unmounted. The default left panel mounts RemoteStateSnapshots,
      // which requests a state list from a public server on mount.
      remoteState: "none",
      controls: { left: "none", right: "none", bottom: "none" },
      disableDragOverlay: true,
      hideTaskOverlay: true,
    },
    layout: {
      initial: {
        isExpanded: false,
        // The sequence strip and all controls are MoleculeDesk's own overlay; Mol* only draws the canvas.
        showControls: false,
        regionState: { left: "hidden", top: "hidden", right: "hidden", bottom: "hidden" },
      },
    },
    config: [
      [PluginConfig.VolumeStreaming.Enabled, false],
      [PluginConfig.Viewport.ShowExpand, false],
      [PluginConfig.Viewport.ShowToggleFullscreen, false],
      [PluginConfig.Viewport.ShowControls, false],
      [PluginConfig.Viewport.ShowSettings, false],
      [PluginConfig.Viewport.ShowSelectionMode, false],
      [PluginConfig.Viewport.ShowAnimation, false],
      [PluginConfig.Viewport.ShowTrajectoryControls, false],
      [PluginConfig.Viewport.ShowScreenshotControls, false],
      [PluginConfig.Viewport.ShowReset, false],
      [PluginConfig.Viewport.ShowIllumination, false],
      [PluginConfig.Viewport.ShowXR, "never"],
    ],
  };
}

type Builders = PluginUIContext["builders"];

const DNA = MS.core.str.match([MS.re("polydeoxyribonucleotide", "i"), MS.ammp("entitySubtype")]);
const RNA = MS.core.logic.and([
  MS.core.str.match([MS.re("^polyribonucleotide", "i"), MS.ammp("entitySubtype")]),
]);

function entityTest(inner: Expression) {
  return MS.struct.modifier.union([
    MS.struct.generator.atomGroups({
      "entity-test": MS.core.logic.and([MS.core.rel.eq([MS.ammp("entityType"), "polymer"]), inner]),
    }),
  ]);
}

/** Maps the report's selection language to a MolScript expression. */
export function selectionExpression(selection: MolecularSelection): Expression {
  switch (selection.kind) {
    case "all":
      return MS.struct.generator.all();
    case "molecule":
      switch (selection.type) {
        case "protein":
          return StructureSelectionQueries.protein.expression;
        case "nucleic":
          return StructureSelectionQueries.nucleic.expression;
        case "dna":
          return entityTest(DNA);
        case "rna":
          return entityTest(RNA);
        case "ligand":
          return StructureSelectionQueries.ligand.expression;
        case "ion":
          return StructureSelectionQueries.ion.expression;
        case "water":
          return StructureSelectionQueries.water.expression;
      }
      break;
    case "chains":
      return MS.struct.modifier.union([
        MS.struct.generator.atomGroups({
          "chain-test": MS.core.set.has([
            MS.set(...selection.ids),
            MS.ammp(selection.namespace === "auth" ? "auth_asym_id" : "label_asym_id"),
          ]),
        }),
      ]);
    case "entities":
      return MS.struct.modifier.union([
        MS.struct.generator.atomGroups({
          "entity-test": MS.core.set.has([MS.set(...selection.ids), MS.ammp("label_entity_id")]),
        }),
      ]);
    case "residues":
      return MS.struct.modifier.union([
        MS.struct.combinator.merge(
          selection.residues.map((r) =>
            MS.struct.modifier.union([
              MS.struct.generator.atomGroups({
                "chain-test": MS.core.rel.eq([
                  MS.ammp(r.chainNamespace === "auth" ? "auth_asym_id" : "label_asym_id"),
                  r.chainId,
                ]),
                "residue-test": MS.core.logic.and([
                  MS.core.rel.eq([
                    MS.ammp(r.residueNamespace === "auth" ? "auth_seq_id" : "label_seq_id"),
                    r.sequenceId,
                  ]),
                  MS.core.rel.eq([MS.ammp("pdbx_PDB_ins_code"), r.insertionCode ?? ""]),
                ]),
              }),
            ]),
          ),
        ),
      ]);
  }
  return MS.struct.generator.all();
}

const REPRESENTATION_TYPE: Record<RepresentationKind, string> = {
  cartoon: "cartoon",
  sticks: "ball-and-stick",
  surface: "gaussian-surface",
};

function parseColor(hex: string): Color {
  return Color(parseInt(hex.slice(1), 16));
}

function hex(c: Color): string {
  return `#${(c as number).toString(16).padStart(6, "0")}`;
}

export class Viewer {
  private readonly loci = new Map<string, StructureElement.Loci>();
  private selectedKey: string | undefined;

  private constructor(private readonly plugin: PluginUIContext) {}

  static async create(target: HTMLElement): Promise<Viewer> {
    const plugin = await createPluginUI({
      target,
      render: renderReact18,
      spec: offlineSpec(),
    });
    return new Viewer(plugin);
  }

  get canvas(): HTMLCanvasElement | undefined {
    return this.plugin.canvas3d?.webgl ? (this.plugin.canvas3dContext?.canvas as HTMLCanvasElement) : undefined;
  }

  async loadScene(
    scene: Scene,
    resources: ReadonlyMap<string, LoadedResource>,
    options: SceneOptions,
  ): Promise<SceneSummary> {
    const { plugin } = this;
    await plugin.clear();
    const b: Builders = plugin.builders;
    const structures = new Map<string, StateObjectSelector>();
    let hasPolymerSequence = false;
    let modelCount = 1;

    for (const s of scene.structures) {
      const resource = resources.get(s.resourceId);
      if (!resource) throw new Error(`Missing resource "${s.resourceId}"`);
      const text = new TextDecoder().decode(resource.bytes);
      const data = await b.data.rawData({ data: text, label: s.id }, { state: { isGhost: true } });
      const trajectory = await b.structure.parseTrajectory(data, resource.format);
      modelCount = Math.max(modelCount, trajectory.data?.frameCount ?? 1);
      const model = await b.structure.createModel(trajectory, { modelIndex: s.modelIndex ?? 0 });
      let structure = await b.structure.createStructure(
        model,
        s.assemblyId === undefined
          ? { name: "model", params: {} }
          : { name: "assembly", params: { id: s.assemblyId } },
      );
      if (s.transform) {
        const update = plugin.state.data.build().to(structure).apply(StateTransforms.Model.TransformStructureConformation, {
          transform: { name: "matrix", params: { data: Mat4.fromArray(Mat4(), s.transform, 0), transpose: false } },
        });
        const result = await update.commit();
        void result;
        structure = update.selector as unknown as typeof structure;
      }
      structures.set(s.id, structure);
      if (structure.data) {
        hasPolymerSequence ||= structure.data.polymerResidueCount > 0;
      }
    }

    for (const [id, structure] of structures) {
      const overrides = scene.components?.filter((c) => c.structureId === id) ?? [];
      if (scene.components && scene.components.length > 0) {
        for (const c of overrides) await this.addComponent(structure, c, options);
      } else {
        await this.addDefaults(structure, options);
      }
    }
    PluginCommands.Camera.Reset(plugin, {});
    const sequences = this.buildSequences(structures, structures.size > 1);
    return {
      sceneId: scene.id,
      structureCount: structures.size,
      hasPolymerSequence,
      modelCount,
      sequences: sequences.rows,
      sequenceRowsOmitted: sequences.omitted,
    };
  }

  /** Representations currently drawn, each with the (sub)structure it draws. */
  private drawnRepresentations(): Array<{ source: Structure; color?: (l: StructureElement.Location) => number }> {
    const out: Array<{ source: Structure; color?: (l: StructureElement.Location) => number }> = [];
    this.plugin.state.data.cells.forEach((cell) => {
      const obj = cell.obj;
      if (!obj || !PluginStateObject.Molecule.Structure.Representation3D.is(obj)) return;
      const { repr, sourceData } = obj.data;
      const theme = repr.theme.color as { color?: (l: StructureElement.Location, s: boolean) => number };
      out.push({ source: sourceData, color: theme.color ? (l) => theme.color!(l, false) : undefined });
    });
    return out;
  }

  /**
   * One row per polymer chain, using the structure's full entity sequence so residues that were
   * not modeled keep their position. Letter colors come from the same color theme Mol* draws with.
   */
  private buildSequences(structures: Map<string, StateObjectSelector>, multi: boolean) {
    this.loci.clear();
    this.selectedKey = undefined;
    const reprs = this.drawnRepresentations();
    type Modeled = { comp: string; auth: number; ins: string; element: number; loci?: StructureElement.Loci; color?: string };
    const chains = new Map<string, { label: string; structure: Structure; entity: number; model: Unit.Atomic["model"]; residues: Map<number, Modeled> }>();

    for (const [sid, selector] of structures) {
      const structure = selector.data as Structure | undefined;
      if (!structure) continue;
      for (const unit of structure.units) {
        if (!Unit.isAtomic(unit) || !unit.conformation.operator.isIdentity || unit.polymerElements.length === 0) continue;
        const h = unit.model.atomicHierarchy;
        const first = unit.polymerElements[0];
        const chainIndex = h.chainAtomSegments.index[first];
        const asym = h.chains.label_asym_id.value(chainIndex);
        const key = `${sid}:${unit.model.id}:${asym}`;
        let chain = chains.get(key);
        if (!chain) {
          const auth = h.chains.auth_asym_id.value(chainIndex);
          chain = {
            label: multi ? `${sid} ${auth}` : auth,
            structure,
            entity: h.index.getEntityFromChain(chainIndex),
            model: unit.model,
            residues: new Map(),
          };
          chains.set(key, chain);
        }
        for (let k = 0; k < unit.polymerElements.length; k++) {
          const e = unit.polymerElements[k];
          const rI = h.residueAtomSegments.index[e];
          const seqId = h.residues.label_seq_id.value(rI);
          const start = h.residueAtomSegments.offsets[rI];
          const end = h.residueAtomSegments.offsets[rI + 1];
          const range = SortedArray.findRange(unit.elements, start as ElementIndex, (end - 1) as ElementIndex);
          let color: string | undefined;
          for (const r of reprs) {
            const sub = r.source.unitMap.get(unit.id);
            if (!r.color || !sub || sub.model !== unit.model || !SortedArray.has(sub.elements, e)) continue;
            try {
              color = hex(r.color(StructureElement.Location.create(r.source, sub, e)) as unknown as Color);
            } catch {
              continue;
            }
            break;
          }
          chain.residues.set(seqId, {
            comp: h.atoms.label_comp_id.value(e),
            auth: h.residues.auth_seq_id.value(rI),
            ins: h.residues.pdbx_PDB_ins_code.value(rI),
            element: e,
            loci: StructureElement.Loci(structure, [{ unit, indices: range as never }]),
            color,
          });
        }
      }
    }

    const rows: SequenceRow[] = [];
    let omitted = 0;
    for (const [key, chain] of chains) {
      if (rows.length >= MAX_SEQUENCE_ROWS) {
        omitted++;
        continue;
      }
      const entitySeq = chain.model.sequence.byEntityKey[chain.entity]?.sequence;
      const residues: SequenceResidue[] = [];
      const push = (letter: string, seqId: number, comp: string, modeled: Modeled | undefined, modified: boolean) => {
        const index = residues.length;
        const authText = modeled && modeled.auth !== seqId ? ` [auth ${modeled.auth}]${modeled.ins}` : modeled?.ins ? modeled.ins : "";
        const title = modeled ? `${modeled.comp} ${seqId}${authText}` : `${comp} ${seqId} (not modeled)`;
        residues.push({ letter, seqId, comp: modeled?.comp ?? comp, title, color: modeled?.color, modeled: !!modeled, modified });
        if (modeled?.loci) this.loci.set(`${key}:${index}`, modeled.loci);
      };
      if (entitySeq) {
        for (let i = 0; i < entitySeq.length; i++) {
          const seqId = entitySeq.seqId.value(i);
          const modeled = chain.residues.get(seqId);
          const code = entitySeq.code.value(i) as string;
          const letter = code === "X" || code === "-" ? entitySeq.label.value(i) : code;
          push(letter, seqId, entitySeq.compId.value(i), modeled, !!modeled && (letter.length > 1 || modeled.comp !== entitySeq.compId.value(i)));
        }
      } else {
        for (const [seqId, m] of [...chain.residues].sort((a, b) => a[0] - b[0])) push("X", seqId, m.comp, m, false);
      }
      if (residues.length > 0) rows.push({ key, label: chain.label, residues });
    }
    return { rows, omitted };
  }

  /** Highlights a sequence residue in the 3D view (no argument clears). */
  highlight(key?: string, index?: number): void {
    const { lociHighlights } = this.plugin.managers.interactivity;
    const loci = key === undefined ? undefined : this.loci.get(`${key}:${index}`);
    if (loci) lociHighlights.highlightOnly({ loci }, false);
    else lociHighlights.clearHighlights();
  }

  /** Selects and focuses a residue; clicking the selected residue again clears it. */
  toggleSelect(key: string, index: number): void {
    const id = `${key}:${index}`;
    const loci = this.loci.get(id);
    if (!loci) return;
    const { selection } = this.plugin.managers.structure;
    if (this.selectedKey === id) {
      selection.clear();
      this.selectedKey = undefined;
      return;
    }
    this.selectedKey = id;
    selection.fromLoci("set", loci);
    this.plugin.managers.camera.focusLoci(loci);
  }

  private async addDefaults(structure: StateObjectSelector, options: SceneOptions) {
    const b = this.plugin.builders;
    const polymer = await b.structure.tryCreateComponentStatic(structure, "polymer");
    if (polymer) {
      await b.structure.representation.addRepresentation(polymer, {
        type: REPRESENTATION_TYPE[options.representation] as "cartoon",
        color: "chain-id",
      });
    }
    if (options.showLigands) {
      for (const kind of ["ligand", "ion", "branched"] as const) {
        const comp = await b.structure.tryCreateComponentStatic(structure, kind);
        if (comp) await b.structure.representation.addRepresentation(comp, { type: "ball-and-stick", color: "element-symbol" });
      }
    }
    if (options.showWater) {
      const water = await b.structure.tryCreateComponentStatic(structure, "water");
      if (water) await b.structure.representation.addRepresentation(water, { type: "ball-and-stick", color: "element-symbol" });
    }
  }

  private async addComponent(structure: StateObjectSelector, c: SceneComponent, options: SceneOptions) {
    const b = this.plugin.builders;
    const comp = await b.structure.tryCreateComponentFromExpression(structure, selectionExpression(c.selection), c.id, {
      label: c.label ?? c.id,
    });
    if (!comp) return;
    const kind = c.representation ?? options.representation;
    await b.structure.representation.addRepresentation(comp, {
      type: REPRESENTATION_TYPE[kind] as "cartoon",
      ...(c.color
        ? { color: "uniform" as const, colorParams: { value: parseColor(c.color) } }
        : { color: (kind === "sticks" ? "element-symbol" : "chain-id") as "chain-id" }),
    });
  }

  resetCamera(): void {
    PluginCommands.Camera.Reset(this.plugin, {});
  }

  setBackground(color: string): void {
    const canvas3d = this.plugin.canvas3d;
    canvas3d?.setProps({ renderer: { backgroundColor: parseColor(color) } });
  }

  /** PNG as a data URI (no network, no file system). */
  async exportPng(): Promise<string> {
    return this.plugin.helpers.viewportScreenshot!.getImageDataUri();
  }

  dispose(): void {
    this.plugin.dispose();
  }
}

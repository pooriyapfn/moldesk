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

export interface SceneSummary {
  hasPolymerSequence: boolean;
  modelCount: number;
}

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
        // Keep the sequence strip inside the container instead of outside its bounds.
        controlsDisplay: "landscape",
        // Must be true or Mol* hides every region, including the sequence strip.
        showControls: true,
        // Sequence strip on top; everything else is our own shell.
        regionState: { left: "hidden", top: "full", right: "hidden", bottom: "hidden" },
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

export class Viewer {
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
    return { hasPolymerSequence, modelCount };
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
        : { color: "chain-id" as const }),
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

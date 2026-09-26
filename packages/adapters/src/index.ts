export interface InstallContext {
  manifestName: string;
  modelDir: string;
  assetsDir: string;
  runner?: import("@moldesk/runtime").InstallCommandRunner;
  /** The host platform the runtime entry being installed/verified was resolved
   * for. Populated by the core installer from its own platform-selection result
   * — never guessed from `process.platform` by the adapter — so `verifyInstallation`
   * can pick the right probe (e.g. CUDA vs MPS) even before `installation.json`
   * exists (during the pre-promotion staging-directory verify). */
  platform?: import("@moldesk/registry").PlatformId;
}

export interface RunContext {
  manifestName: string;
  /** Absolute path to the copied input inside the run directory, never the user's original path. */
  inputPath: string;
  /** The run directory's `output/` subdir. `collectOutputs` must only look here. */
  outputDir: string;
  modelDir: string;
  assetsDir: string;
  /** Normalized, validated, defaulted params (see `ParamDescriptor`/`validateParams`). */
  params: Record<string, unknown>;
  /** Resolved runtime executable (e.g. the managed venv's `python`) for this run. */
  runtimeExecutable: string;
  /** The host platform the installed runtime was resolved for, when determinable.
   * Lets an adapter's `command()` cross-validate a param (e.g. accelerator) against
   * the *installed* runtime rather than guessing from `process.platform`. */
  platform?: import("@moldesk/registry").PlatformId;
  /** Staged companion inputs (see `resolveCompanionInputs`), keyed by the same
   * `id` the adapter declared. Populated only when `resolveCompanionInputs`
   * returned entries for this run's job file; absent for single-file models. */
  companionInputs?: Array<{ id: string; path: string }>;
}

/**
 * Minimal, structural view of an `InstalledModel` record (from `@moldesk/core`)
 * that `resolveParamDefaults` needs. Defined locally rather than importing
 * `InstalledModel` from `@moldesk/core` because `@moldesk/core` depends on
 * `@moldesk/adapters` — importing the other way would be a package cycle.
 */
export interface ResolveParamDefaultsInstalledRuntime {
  kind: string;
  python?: {
    platform?: import("@moldesk/registry").PlatformId;
    platformSelected?: boolean;
  };
}

export interface ResolveParamDefaultsContext {
  manifestName: string;
  installed: { runtime: ResolveParamDefaultsInstalledRuntime };
}

export interface ParamDescriptor {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
  description?: string;
}

export interface InstallPlanStep {
  readonly id: string;
  readonly description: string;
}

export interface InstallPlan {
  readonly steps: readonly InstallPlanStep[];
}

export interface CollectedOutput {
  id: string;
  path: string;
}

export interface VerificationResult {
  passed: boolean;
  output?: string;
}

export interface ModelAdapterDefinition {
  readonly modelName: string;
  /** Params this model accepts via `--param key=value`; empty/omitted if none. */
  readonly params?: ParamDescriptor[];
  validateInput(inputPath: string): Promise<void>;
  installPlan(context: InstallContext): Promise<InstallPlan>;
  command(context: RunContext): Promise<import("@moldesk/registry").CommandSpec>;
  collectOutputs(context: RunContext): Promise<CollectedOutput[]>;
  verifyInstallation(context: InstallContext): Promise<VerificationResult>;
  /**
   * Optional hook for params whose correct default depends on which platform's
   * runtime entry was actually installed (e.g. Boltz's `accelerator`: `mps` on a
   * Darwin/boltz-community install, `gpu` on a Linux/CUDA install) rather than a
   * single static `ParamDescriptor.default`. When present, `runModel` calls this
   * *before* `validateParams`, merging the result in as additional defaults — a
   * key here only fills in when the caller didn't explicitly supply `--param
   * <key>=...`, and a declared `ParamDescriptor.default` only applies when this
   * hook doesn't supply that key. This makes the resolved value visible in
   * `run.json`'s `parameters.effective` up front, not only deep inside `command()`.
   */
  resolveParamDefaults?(context: ResolveParamDefaultsContext): Record<string, unknown>;
  /**
   * Optional hook for models whose job file references companion files that must
   * be safely staged alongside the primary input (e.g. DiffDock-L's job JSON
   * referencing a separate protein PDB and ligand file). Given the *original*
   * (pre-copy) resolved job file path, returns the companion references to
   * stage; `run.ts` then validates and copies each one via
   * `@moldesk/runtime`'s `stageCompanionInputs` and passes the staged paths back
   * as `RunContext.companionInputs`. Absent means unchanged single-file
   * behavior — no companion staging occurs. All job-format-specific parsing
   * (what a reference means, how it's found) stays here in the adapter; `core`/
   * `runtime` only provide generic, validated staging.
   */
  resolveCompanionInputs?(inputPath: string): Promise<import("@moldesk/runtime").CompanionInputRef[]>;
}

export { adapterCatalog, getAdapter, hasAdapter, validateAdapterCatalog } from "./catalog.js";
export { validateParams, type ParamValidationResult } from "./params.js";

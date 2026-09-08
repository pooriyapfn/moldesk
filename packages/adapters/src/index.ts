export interface InstallContext {
  manifestName: string;
  modelDir: string;
  assetsDir: string;
}

export interface RunContext {
  manifestName: string;
  inputPath: string;
  outputDir: string;
  modelDir: string;
  assetsDir: string;
}

export interface InstallPlanStep {
  id: string;
  description: string;
}

export interface InstallPlan {
  steps: InstallPlanStep[];
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
  validateInput(inputPath: string): Promise<void>;
  installPlan(context: InstallContext): Promise<InstallPlan>;
  command(context: RunContext): Promise<import("@moldesk/registry").CommandSpec>;
  collectOutputs(context: RunContext): Promise<CollectedOutput[]>;
  verifyInstallation(context: InstallContext): Promise<VerificationResult>;
}

export { adapterCatalog } from "./catalog.js";

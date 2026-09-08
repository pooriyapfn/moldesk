import type { CommandSpec } from "@moldesk/registry";
import type {
  CollectedOutput,
  InstallContext,
  InstallPlan,
  ModelAdapterDefinition,
  RunContext,
  VerificationResult,
} from "../index.js";
import { plannedAdapterOperation } from "../planned.js";

export const proteinmpnnAdapter: ModelAdapterDefinition = {
  modelName: "proteinmpnn",
  async validateInput(_inputPath: string): Promise<void> {
    plannedAdapterOperation("proteinmpnn", "validate input");
  },
  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return plannedAdapterOperation("proteinmpnn", "create an installation plan");
  },
  async command(_context: RunContext): Promise<CommandSpec> {
    return plannedAdapterOperation("proteinmpnn", "build a run command");
  },
  async collectOutputs(_context: RunContext): Promise<CollectedOutput[]> {
    return plannedAdapterOperation("proteinmpnn", "collect outputs");
  },
  async verifyInstallation(_context: InstallContext): Promise<VerificationResult> {
    return plannedAdapterOperation("proteinmpnn", "verify an installation");
  },
};

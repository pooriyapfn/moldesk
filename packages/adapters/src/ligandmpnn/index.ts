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

export const ligandmpnnAdapter: ModelAdapterDefinition = {
  modelName: "ligandmpnn",
  async validateInput(_inputPath: string): Promise<void> {
    plannedAdapterOperation("ligandmpnn", "validate input");
  },
  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return plannedAdapterOperation("ligandmpnn", "create an installation plan");
  },
  async command(_context: RunContext): Promise<CommandSpec> {
    return plannedAdapterOperation("ligandmpnn", "build a run command");
  },
  async collectOutputs(_context: RunContext): Promise<CollectedOutput[]> {
    return plannedAdapterOperation("ligandmpnn", "collect outputs");
  },
  async verifyInstallation(_context: InstallContext): Promise<VerificationResult> {
    return plannedAdapterOperation("ligandmpnn", "verify an installation");
  },
};

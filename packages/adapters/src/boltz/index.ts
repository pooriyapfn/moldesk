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

export const boltzAdapter: ModelAdapterDefinition = {
  modelName: "boltz",
  async validateInput(_inputPath: string): Promise<void> {
    plannedAdapterOperation("boltz", "validate input");
  },
  async installPlan(_context: InstallContext): Promise<InstallPlan> {
    return plannedAdapterOperation("boltz", "create an installation plan");
  },
  async command(_context: RunContext): Promise<CommandSpec> {
    return plannedAdapterOperation("boltz", "build a run command");
  },
  async collectOutputs(_context: RunContext): Promise<CollectedOutput[]> {
    return plannedAdapterOperation("boltz", "collect outputs");
  },
  async verifyInstallation(_context: InstallContext): Promise<VerificationResult> {
    return plannedAdapterOperation("boltz", "verify an installation");
  },
};

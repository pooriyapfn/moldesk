import type { RuntimeKind } from "@moldesk/registry";

export type CompatibilityStatus = "compatible" | "warning" | "unsupported";

export interface CompatibilityReason {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  remediation?: string;
}

export interface CompatibilityResult {
  status: CompatibilityStatus;
  selectedRuntime?: RuntimeKind;
  reasons: CompatibilityReason[];
}

import { MoldeskError } from "@moldesk/registry";

export function plannedAdapterOperation(modelName: string, operation: string): never {
  throw new MoldeskError({
    code: "ADAPTER_NOT_IMPLEMENTED",
    message: `Model adapter "${modelName}" cannot ${operation} yet.`,
    remediation: `The model is listed as planned. Wait until its install/run vertical slice is verified and marked available.`,
    details: { modelName, operation },
  });
}

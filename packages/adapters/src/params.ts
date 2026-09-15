import type { ParamDescriptor } from "./index.js";

export interface ParamValidationResult {
  effective: Record<string, unknown>;
  errors: string[];
}

function coerce(descriptor: ParamDescriptor, raw: string, errors: string[]): unknown {
  switch (descriptor.type) {
    case "string":
      if (descriptor.enum && !descriptor.enum.includes(raw)) {
        errors.push(`--param ${descriptor.name}: "${raw}" is not one of ${descriptor.enum.join(", ")}.`);
      }
      return raw;
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        errors.push(`--param ${descriptor.name}: "${raw}" is not a number.`);
        return undefined;
      }
      if (descriptor.min !== undefined && value < descriptor.min) {
        errors.push(`--param ${descriptor.name}: ${value} is below the minimum of ${descriptor.min}.`);
      }
      if (descriptor.max !== undefined && value > descriptor.max) {
        errors.push(`--param ${descriptor.name}: ${value} is above the maximum of ${descriptor.max}.`);
      }
      if (descriptor.enum && !descriptor.enum.includes(value)) {
        errors.push(`--param ${descriptor.name}: ${value} is not one of ${descriptor.enum.join(", ")}.`);
      }
      return value;
    }
    case "boolean": {
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      errors.push(`--param ${descriptor.name}: "${raw}" is not a boolean (use true/false).`);
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Validates and normalizes `--param key=value` input against an adapter's
 * declared params. Rejects unknown keys, coerces by declared type, enforces
 * min/max/enum, and fills defaults for missing non-required params.
 * Collects every error rather than stopping at the first, so the CLI can
 * report all problems in one pass.
 */
export function validateParams(
  descriptors: ParamDescriptor[],
  supplied: Record<string, string>,
): ParamValidationResult {
  const errors: string[] = [];
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

  for (const key of Object.keys(supplied)) {
    if (!byName.has(key)) {
      errors.push(`Unknown parameter "${key}". Accepted parameters: ${descriptors.map((d) => d.name).join(", ") || "(none)"}.`);
    }
  }

  const effective: Record<string, unknown> = {};
  for (const descriptor of descriptors) {
    const raw = supplied[descriptor.name];
    if (raw === undefined) {
      if (descriptor.required) {
        errors.push(`Missing required parameter "${descriptor.name}".`);
      } else if (descriptor.default !== undefined) {
        effective[descriptor.name] = descriptor.default;
      }
      continue;
    }
    const value = coerce(descriptor, raw, errors);
    if (value !== undefined) effective[descriptor.name] = value;
  }

  return { effective, errors };
}

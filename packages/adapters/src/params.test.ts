import { describe, expect, it } from "vitest";
import type { ParamDescriptor } from "./index.js";
import { validateParams } from "./params.js";

const descriptors: ParamDescriptor[] = [
  { name: "count", type: "number", default: 1, min: 1, max: 10 },
  { name: "mode", type: "string", enum: ["fast", "slow"], required: true },
  { name: "verbose", type: "boolean", default: false },
];

describe("validateParams", () => {
  it("fills defaults for missing non-required params", () => {
    const { effective, errors } = validateParams(descriptors, { mode: "fast" });
    expect(errors).toEqual([]);
    expect(effective).toEqual({ count: 1, mode: "fast", verbose: false });
  });

  it("coerces declared types", () => {
    const { effective, errors } = validateParams(descriptors, { count: "5", mode: "slow", verbose: "true" });
    expect(errors).toEqual([]);
    expect(effective).toEqual({ count: 5, mode: "slow", verbose: true });
  });

  it("rejects an unknown parameter", () => {
    const { errors } = validateParams(descriptors, { mode: "fast", bogus: "1" });
    expect(errors.some((e) => e.includes('Unknown parameter "bogus"'))).toBe(true);
  });

  it("reports a missing required parameter", () => {
    const { errors } = validateParams(descriptors, {});
    expect(errors.some((e) => e.includes('Missing required parameter "mode"'))).toBe(true);
  });

  it("enforces min/max/enum and collects every error in one pass", () => {
    const { errors } = validateParams(descriptors, { count: "999", mode: "medium" });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.includes("above the maximum"))).toBe(true);
    expect(errors.some((e) => e.includes("is not one of"))).toBe(true);
  });

  it("rejects a non-numeric value for a number param", () => {
    const { errors } = validateParams(descriptors, { count: "abc", mode: "fast" });
    expect(errors.some((e) => e.includes("is not a number"))).toBe(true);
  });

  it("rejects a non-boolean value for a boolean param", () => {
    const { errors } = validateParams(descriptors, { mode: "fast", verbose: "maybe" });
    expect(errors.some((e) => e.includes("is not a boolean"))).toBe(true);
  });
});

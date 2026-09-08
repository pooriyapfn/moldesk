import { describe, expect, it } from "vitest";
import { MoldeskError as RegistryMoldeskError } from "@moldesk/registry";
import { MoldeskError as RuntimeMoldeskError } from "./providers.js";

describe("runtime public contracts", () => {
  it("re-exports the canonical MoldeskError class", () => {
    expect(RuntimeMoldeskError).toBe(RegistryMoldeskError);
    const error = new RuntimeMoldeskError({ code: "TEST", message: "test" });
    expect(error).toBeInstanceOf(RegistryMoldeskError);
  });
});

import { describe, expect, it } from "vitest";
import { MoldeskError } from "./errors.js";

describe("MoldeskError", () => {
  it("carries code, message, remediation, and details", () => {
    const error = new MoldeskError({
      code: "DEMO_CODE",
      message: "demo failure",
      remediation: "do the thing",
      details: { hello: "world" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("DEMO_CODE");
    expect(error.remediation).toBe("do the thing");
    expect(error.details).toEqual({ hello: "world" });
  });
});

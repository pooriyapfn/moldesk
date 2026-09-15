import { describe, expect, it } from "vitest";
import { redactEnv } from "./redact.js";

describe("redactEnv", () => {
  it("redacts values whose keys look like secrets", () => {
    expect(
      redactEnv({ API_TOKEN: "abc123", DB_PASSWORD: "hunter2", HOME: "/home/user", PATH: "/usr/bin" }),
    ).toEqual({ API_TOKEN: "[redacted]", DB_PASSWORD: "[redacted]", HOME: "/home/user", PATH: "/usr/bin" });
  });

  it("redacts caller-declared sensitive keys regardless of name", () => {
    expect(redactEnv({ MODEL_LICENSE_ID: "xyz" }, ["MODEL_LICENSE_ID"])).toEqual({ MODEL_LICENSE_ID: "[redacted]" });
  });

  it("returns an empty object for undefined input", () => {
    expect(redactEnv(undefined)).toEqual({});
  });

  it("leaves non-matching keys untouched", () => {
    expect(redactEnv({ OUTPUT_DIR: "/tmp/out" })).toEqual({ OUTPUT_DIR: "/tmp/out" });
  });
});

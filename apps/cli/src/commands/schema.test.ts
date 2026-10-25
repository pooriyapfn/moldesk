import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSchemaCommand } from "./schema.js";

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerSchemaCommand(program);
  await program.parseAsync(["schema", ...args], { from: "user" });
}

describe("moldesk schema", () => {
  it("prints the schema for a kind", async () => {
    await run("moldesk.analysis");
    expect(JSON.parse(out.join("\n")).properties.kind.const).toBe("moldesk.analysis");
    expect(process.exitCode).toBeUndefined();
  });

  it("lists the kinds without an argument", async () => {
    await run();
    expect(JSON.parse(out.join("\n")).kinds).toContain("moldesk.compare");
  });

  it("exits 2 with a JSON error for an unknown kind", async () => {
    await run("nope");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ status: "error", code: "UNKNOWN_SCHEMA_KIND" });
    expect(process.exitCode).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { ContractError, validateDescription, validateReport } from "./contract.js";

const sha = "a".repeat(64);

function report(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "r1",
    title: "T",
    resources: [
      { id: "p", label: "p.pdb", format: "pdb", sha256: sha, sizeBytes: 3, encoding: "base64", data: "YWJj" },
      { id: "t", label: "t.csv", format: "csv", sha256: sha, sizeBytes: 3, encoding: "base64", data: "YWJj" },
    ],
    scenes: [{ id: "s1", title: "S", structures: [{ id: "a", resourceId: "p" }] }],
    panels: [],
    provenance: { createdAt: "2026-10-10T00:00:00.000Z" },
    ...overrides,
  };
}

describe("validateReport", () => {
  it("accepts a minimal report", () => {
    expect(validateReport(report()).scenes).toHaveLength(1);
  });

  it("allows chart-only reports", () => {
    expect(validateReport(report({ scenes: [] })).scenes).toEqual([]);
  });

  it.each([
    ["unknown schema", { schemaVersion: 2 }],
    ["unknown top-level key", { extra: 1 }],
    ["scene referencing a data resource", { scenes: [{ id: "s", title: "S", structures: [{ id: "a", resourceId: "t" }] }] }],
    ["scene referencing a missing resource", { scenes: [{ id: "s", title: "S", structures: [{ id: "a", resourceId: "zz" }] }] }],
    ["duplicate scene ids", { scenes: [
      { id: "s", title: "S", structures: [{ id: "a", resourceId: "p" }] },
      { id: "s", title: "S", structures: [{ id: "a", resourceId: "p" }] },
    ] }],
    ["bad transform length", { scenes: [{ id: "s", title: "S", structures: [{ id: "a", resourceId: "p", transform: [1, 2] }] }] }],
    ["non-finite transform", { scenes: [{ id: "s", title: "S", structures: [{ id: "a", resourceId: "p", transform: Array(16).fill(Infinity) }] }] }],
    ["css injection color", { scenes: [{ id: "s", title: "S", structures: [{ id: "a", resourceId: "p" }],
      components: [{ id: "c", structureId: "a", selection: { kind: "all" }, color: "red;background:url(x)" }] }] }],
    ["table on a molecular resource", { panels: [{ id: "x", kind: "table", dataset: { resourceId: "p" }, columns: [] }] }],
    ["panel referencing unknown scene", { panels: [{ id: "x", kind: "structure", sceneIds: ["nope"] }] }],
    ["hash mismatch in size", { resources: [{ id: "p", label: "p", format: "pdb", sha256: sha, sizeBytes: 99, encoding: "base64", data: "YWJj" }] }],
    ["bad sha", { resources: [{ id: "p", label: "p", format: "pdb", sha256: "xyz", sizeBytes: 3, encoding: "base64", data: "YWJj" }] }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => validateReport(report(overrides))).toThrow(ContractError);
  });

  it("rejects __proto__ keys", () => {
    const evil = JSON.parse('{"schemaVersion":1,"__proto__":{"x":1}}');
    expect(() => validateReport(evil)).toThrow(ContractError);
  });

  it("rejects a __proto__ rowsKey", () => {
    expect(() =>
      validateReport(report({
        resources: [
          { id: "p", label: "p", format: "pdb", sha256: sha, sizeBytes: 3, encoding: "base64", data: "YWJj" },
          { id: "j", label: "j", format: "json", sha256: sha, sizeBytes: 3, encoding: "base64", data: "YWJj" },
        ],
        panels: [{ id: "x", kind: "table", dataset: { resourceId: "j", rowsKey: "__proto__" }, columns: [] }],
      })),
    ).toThrow(ContractError);
  });
});

describe("validateDescription", () => {
  const base = {
    title: "T",
    resources: [{ id: "p", source: { kind: "output", path: "/run/output/a.cif" }, format: "mmcif", label: "a" }],
    scenes: [{ id: "s", title: "S", structures: [{ id: "a", resourceId: "p" }] }],
    panels: [],
  };

  it("accepts a description", () => {
    expect(validateDescription(base).resources).toHaveLength(1);
  });

  it("rejects URL sources", () => {
    const bad = { ...base, resources: [{ ...base.resources[0], source: { kind: "output", path: "https://x/a.cif" } }] };
    expect(() => validateDescription(bad)).toThrow(/URLs are not allowed/);
  });

  it("rejects duplicate resource ids", () => {
    const bad = { ...base, resources: [base.resources[0], base.resources[0]] };
    expect(() => validateDescription(bad)).toThrow(/duplicate id/);
  });
});

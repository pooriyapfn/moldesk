import { describe, expect, it } from "vitest";
import { MoldeskError } from "../errors.js";
import {
  ENVELOPE_KINDS,
  envelopeSchema,
  schemaForKind,
  validateEnvelope,
  type EnvelopeKind,
} from "./envelope.js";
import { parseSelector } from "./selector.js";

const sha = "a".repeat(64);

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "moldesk.analysis",
    status: "ok",
    input: { path: "x.pdb", format: "pdb", sha256: sha },
    result: { chains: [] },
    warnings: [{ code: "W", message: "careful" }],
    provenance: { moldeskVersion: "0.0.7", tool: { name: "usalign", version: "1" } },
    ...overrides,
  };
}

describe("validateEnvelope", () => {
  it.each(ENVELOPE_KINDS)("accepts a valid %s envelope", (kind) => {
    expect(validateEnvelope(envelope({ kind }), kind).kind).toBe(kind);
  });

  it("accepts an envelope without input or tool", () => {
    const { input: _input, ...rest } = envelope({ provenance: { moldeskVersion: "0.0.7" } });
    expect(() => validateEnvelope(rest)).not.toThrow();
  });

  it.each([
    ["unknown kind", { kind: "moldesk.nope" }],
    ["unknown schemaVersion", { schemaVersion: 2 }],
    ["wrong status", { status: "error" }],
    ["unknown key", { extra: 1 }],
    ["bad format", { input: { path: "x", format: "sdf", sha256: sha } }],
    ["bad sha", { input: { path: "x", format: "pdb", sha256: "xyz" } }],
    ["non-object result", { result: [] }],
    ["bad warning", { warnings: [{ code: "W" }] }],
    ["missing moldeskVersion", { provenance: {} }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => validateEnvelope(envelope(overrides))).toThrow(MoldeskError);
  });

  it("rejects a mismatched expected kind", () => {
    expect(() => validateEnvelope(envelope(), "moldesk.compare")).toThrow(MoldeskError);
  });

  it("rejects __proto__ keys at the top level and inside result", () => {
    const top = JSON.parse('{"schemaVersion":1,"__proto__":{"x":1}}');
    expect(() => validateEnvelope(top)).toThrow(MoldeskError);
    const nested = envelope({ result: JSON.parse('{"a":[{"__proto__":{"x":1}}]}') });
    expect(() => validateEnvelope(nested)).toThrow(MoldeskError);
  });
});

describe("schemas", () => {
  it.each(ENVELOPE_KINDS)("pins the kind const in the %s schema", (kind: EnvelopeKind) => {
    const schema = schemaForKind(kind) as { properties: { kind: { const: string } } };
    expect(schema).toEqual(envelopeSchema(kind));
    expect(schema.properties.kind.const).toBe(kind);
  });

  it("rejects an unknown kind", () => {
    expect(() => schemaForKind("moldesk.nope")).toThrow(/Unknown schema kind/);
  });
});

describe("parseSelector", () => {
  it.each([
    ["A", { namespace: "auth", chainId: "A" }],
    ["A:45", { namespace: "auth", chainId: "A", start: 45, end: 45 }],
    ["A:40-60", { namespace: "auth", chainId: "A", start: 40, end: 60 }],
    ["A:52A", { namespace: "auth", chainId: "A", start: 52, end: 52, insertionCode: "A" }],
    ["AB:-5-10", { namespace: "auth", chainId: "AB", start: -5, end: 10 }],
  ])("parses %s", (text, expected) => {
    expect(parseSelector(text)).toEqual(expected);
  });

  it("uses the label namespace when asked", () => {
    expect(parseSelector("A:1", "label").namespace).toBe("label");
  });

  it.each(["", "A:", ":5", "A:60-40", "A:4x", "A:1:2", "A:40-60A", "A B", "ABCDE"])(
    "rejects %j with INVALID_SELECTOR",
    (text) => {
      expect(() => parseSelector(text)).toThrow(expect.objectContaining({ code: "INVALID_SELECTOR" }));
    },
  );
});

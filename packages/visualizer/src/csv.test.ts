import { describe, expect, it } from "vitest";
import { CsvError, csvRecords, parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("parses quoted cells with commas, quotes and newlines", () => {
    const t = parseCsv('design,note\r\nd1,"a, ""b""\nc"\r\nd2,plain\r\n');
    expect(t.header).toEqual(["design", "note"]);
    expect(t.rows).toEqual([
      ["d1", 'a, "b"\nc'],
      ["d2", "plain"],
    ]);
  });

  it("strips BOM and skips blank lines", () => {
    expect(parseCsv("﻿a,b\n\n1,2\n").rows).toEqual([["1", "2"]]);
  });

  it("rejects ragged rows, unterminated quotes and empty input", () => {
    expect(() => parseCsv("a,b\n1\n")).toThrow(CsvError);
    expect(() => parseCsv('a\n"x')).toThrow(/unterminated/);
    expect(() => parseCsv("")).toThrow(/empty/);
  });

  it("enforces bounds", () => {
    expect(() => parseCsv("a\n1\n2\n3\n", { maxRows: 2 })).toThrow(/rows/);
    expect(() => parseCsv("a,b\n1,2\n", { maxCells: 3 })).toThrow(/cells/);
    expect(() => parseCsv("a\nxxxxxx\n", { maxCellLength: 3 })).toThrow(/longer/);
  });

  it("returns null-prototype records", () => {
    const [rec] = csvRecords(parseCsv("__proto__,b\n1,2\n"));
    expect(Object.getPrototypeOf(rec)).toBeNull();
    expect(rec["__proto__"]).toBe("1");
  });
});

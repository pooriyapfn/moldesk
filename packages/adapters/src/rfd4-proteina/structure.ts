import fs from "node:fs";
import { MoldeskError } from "@moldesk/registry";

const MAX_CIF_BYTES = 64 * 1024 * 1024;

function invalid(file: string, reason: string): never {
  throw new MoldeskError({
    code: "INVALID_RUN_OUTPUT",
    message: `Invalid mmCIF output ${file}: ${reason}.`,
    remediation: "Check stdout.log/stderr.log in the run directory; the model may have failed partway.",
  });
}

type Token = { kind: "loop" } | { kind: "data" } | { kind: "tag"; value: string } | { kind: "value"; value: string };

/** Minimal mmCIF tokenizer: comments, quoted values, `;` text fields, bare tokens. */
function* tokens(source: string): Generator<Token> {
  const n = source.length;
  let i = 0;
  const space = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    const c = source[i]!;
    if (space(c)) {
      i += 1;
    } else if (c === "#") {
      while (i < n && source[i] !== "\n") i += 1;
    } else if (c === ";" && (i === 0 || source[i - 1] === "\n")) {
      const end = source.indexOf("\n;", i + 1);
      if (end === -1) invalid("<file>", "unterminated text field");
      yield { kind: "value", value: source.slice(i + 1, end) };
      i = end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && !(source[j] === c && (j + 1 === n || space(source[j + 1]!)))) {
        if (source[j] === "\n") invalid("<file>", "unterminated quoted value");
        j += 1;
      }
      if (j >= n) invalid("<file>", "unterminated quoted value");
      yield { kind: "value", value: source.slice(i + 1, j) };
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !space(source[j]!)) j += 1;
      const word = source.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === "loop_") yield { kind: "loop" };
      else if (lower.startsWith("data_")) yield { kind: "data" };
      else if (word.startsWith("_")) yield { kind: "tag", value: word };
      else yield { kind: "value", value: word };
      i = j;
    }
  }
}

/**
 * Structurally validates a model-written mmCIF and returns its atom count: a data block, an
 * `_atom_site` loop with whole rows, and finite coordinates for every atom. A correctly named
 * file is not evidence of a valid one; an empty or truncated structure must fail the run.
 */
export function assertValidMmcif(file: string): number {
  const stat = fs.statSync(file);
  if (stat.size === 0) invalid(file, "file is empty");
  if (stat.size > MAX_CIF_BYTES) invalid(file, `file is larger than ${MAX_CIF_BYTES} bytes`);
  const source = fs.readFileSync(file, "utf8");
  let sawData = false;
  let atoms = 0;
  const iterator = tokens(source);
  let current = iterator.next();
  while (!current.done) {
    const token = current.value;
    if (token.kind === "data") {
      sawData = true;
      current = iterator.next();
    } else if (token.kind === "loop") {
      const tags: string[] = [];
      current = iterator.next();
      while (!current.done && current.value.kind === "tag") {
        tags.push(current.value.value);
        current = iterator.next();
      }
      const isAtomSite = tags.length > 0 && tags.every((t) => t.toLowerCase().startsWith("_atom_site."));
      const values: string[] = [];
      while (!current.done && current.value.kind === "value") {
        if (isAtomSite) values.push(current.value.value);
        current = iterator.next();
      }
      if (!isAtomSite) continue;
      const lower = tags.map((t) => t.toLowerCase());
      const columns = ["_atom_site.cartn_x", "_atom_site.cartn_y", "_atom_site.cartn_z"].map((t) => lower.indexOf(t));
      if (columns.some((c) => c < 0)) invalid(file, "_atom_site loop has no Cartn_x/y/z coordinates");
      if (values.length === 0 || values.length % tags.length !== 0) invalid(file, "_atom_site loop is empty or has a partial row");
      const rows = values.length / tags.length;
      for (let row = 0; row < rows; row += 1) {
        for (const column of columns) {
          const raw = values[row * tags.length + column]!;
          const value = Number(raw);
          if (raw === "" || !Number.isFinite(value)) invalid(file, `atom ${row + 1} has a non-numeric coordinate`);
        }
      }
      atoms += rows;
    } else {
      current = iterator.next();
    }
  }
  if (!sawData) invalid(file, "no data_ block");
  if (atoms === 0) invalid(file, "no _atom_site loop with atoms");
  return atoms;
}

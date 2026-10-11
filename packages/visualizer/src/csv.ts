// Bounded RFC 4180-style CSV parser. Browser-neutral: no Node or DOM imports,
// so adapters and the viewer can share it. Cells are always returned as strings.

import { REPORT_LIMITS } from "./limits.js";

export interface CsvTable {
  header: string[];
  rows: string[][];
}

export interface CsvOptions {
  maxRows?: number;
  maxCells?: number;
  maxCellLength?: number;
}

export class CsvError extends Error {
  readonly code = "INVALID_CSV";
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

export function parseCsv(text: string, options: CsvOptions = {}): CsvTable {
  const maxRows = options.maxRows ?? REPORT_LIMITS.maxTableRows;
  const maxCells = options.maxCells ?? REPORT_LIMITS.maxTableCells;
  const maxCellLength = options.maxCellLength ?? REPORT_LIMITS.maxCellLength;

  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cells = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // strip BOM

  const endCell = () => {
    row.push(cell);
    cell = "";
    if (++cells > maxCells) throw new CsvError(`more than ${maxCells} cells`);
  };
  const endRow = () => {
    endCell();
    // Skip fully blank lines (a single empty cell).
    if (!(row.length === 1 && row[0] === "")) {
      records.push(row);
      if (records.length > maxRows + 1) throw new CsvError(`more than ${maxRows} rows`);
    }
    row = [];
  };

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      inQuotes = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += ch;
    }
    if (cell.length > maxCellLength) throw new CsvError(`cell longer than ${maxCellLength} characters`);
  }
  if (inQuotes) throw new CsvError("unterminated quoted cell");
  if (cell !== "" || row.length > 0) endRow();

  const header = records.shift();
  if (!header) throw new CsvError("empty CSV");
  for (const [n, r] of records.entries()) {
    if (r.length !== header.length) {
      throw new CsvError(`row ${n + 2} has ${r.length} cells, expected ${header.length}`);
    }
  }
  return { header, rows: records };
}

/** Rows as objects keyed by header; null-prototype so header names cannot hit Object.prototype. */
export function csvRecords(table: CsvTable): Array<Record<string, string>> {
  return table.rows.map((r) => {
    const rec: Record<string, string> = Object.create(null);
    table.header.forEach((h, k) => {
      rec[h] = r[k];
    });
    return rec;
  });
}

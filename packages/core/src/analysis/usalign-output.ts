// Parser for US-align's full text output (`-outfmt -1 -m -`, which has no banner), written against the real output of
// the pinned version (20260527). Anything that does not match is an error, never a guess.
import { MoldeskError } from "../errors.js";

export interface UsalignResult {
  lengthA: number;
  lengthB: number;
  alignedLength: number;
  /** Å, as printed (two decimals). */
  rmsd: number;
  /** n_identical / n_aligned. */
  sequenceIdentity: number;
  tmScoreByA: number;
  tmScoreByB: number;
  /** Aligned sequences, `-` for a gap. Multimer chains are joined by `*`. Lowercase is nucleic acid. */
  alignedA: string;
  alignedB: string;
  /** Maps structure A onto structure B: x' = t + U x. */
  rotation: [[number, number, number], [number, number, number], [number, number, number]];
  translation: [number, number, number];
}

function unparseable(what: string, output: string): MoldeskError {
  return new MoldeskError({
    code: "USALIGN_OUTPUT_UNPARSEABLE",
    message: `Could not read ${what} from the US-align output.`,
    remediation: "Reinstall US-align with `moldesk install usalign --reinstall --yes`; if it persists, report it.",
    details: { output: output.slice(0, 2000) },
  });
}

const NUMBER = "(-?\\d+(?:\\.\\d+)?)";

export function parseUsalignOutput(output: string): UsalignResult {
  const text = output.replace(/\r/g, "");
  const grab = (re: RegExp, what: string): RegExpExecArray => re.exec(text) ?? (() => { throw unparseable(what, text); })();

  const lengthA = Number(grab(/Length of Structure_1: (\d+) residues/, "the length of structure 1")[1]);
  const lengthB = Number(grab(/Length of Structure_2: (\d+) residues/, "the length of structure 2")[1]);
  const summary = grab(new RegExp(`Aligned length=\\s*(\\d+), RMSD=\\s*${NUMBER}, Seq_ID=n_identical/n_aligned=\\s*${NUMBER}`), "the alignment summary");
  const tmA = grab(new RegExp(`TM-score=\\s*${NUMBER} \\(normalized by length of Structure_1`), "the TM-score for structure 1")[1];
  const tmB = grab(new RegExp(`TM-score=\\s*${NUMBER} \\(normalized by length of Structure_2`), "the TM-score for structure 2")[1];

  const lines = text.split("\n");
  const legend = lines.findIndex((line) => line.startsWith('(":" denotes residue pairs'));
  const alignedA = lines[legend + 1];
  const alignedB = lines[legend + 3];
  if (legend < 0 || alignedA === undefined || alignedB === undefined || alignedA.length !== alignedB.length) {
    throw unparseable("the aligned sequences", text);
  }

  const header = lines.findIndex((line) => line.includes("The rotation matrix to rotate Structure_1 to Structure_2"));
  const rows = lines.slice(header + 2, header + 5).map((line) => {
    const m = new RegExp(`^\\s*(\\d)\\s+${NUMBER}\\s+${NUMBER}\\s+${NUMBER}\\s+${NUMBER}\\s*$`).exec(line);
    return m ? m.slice(1).map(Number) : undefined;
  });
  if (header < 0 || rows.some((row, i) => row === undefined || row[0] !== i)) throw unparseable("the rotation matrix", text);
  const [r0, r1, r2] = rows as number[][];

  return {
    lengthA,
    lengthB,
    alignedLength: Number(summary[1]),
    rmsd: Number(summary[2]),
    sequenceIdentity: Number(summary[3]),
    tmScoreByA: Number(tmA),
    tmScoreByB: Number(tmB),
    alignedA,
    alignedB,
    translation: [r0[1], r1[1], r2[1]],
    rotation: [r0.slice(2) as [number, number, number], r1.slice(2) as [number, number, number], r2.slice(2) as [number, number, number]],
  };
}

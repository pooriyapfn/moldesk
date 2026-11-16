import { MoldeskError } from "../errors.js";

export interface InterfaceScores { ipsaeTargetToBinder: number; ipsaeBinderToTarget: number; ipsaeMax: number }

/** Named columns from the pinned upstream table. Reject duplicates, NaNs and silent zero-exit failures. */
export function parseIpsaeOutput(text: string, target: string, binder: string, pae: number, distance: number): InterfaceScores {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/));
  const header = lines.find((row) => row[0] === "Chn1" && row.includes("ipSAE"));
  const fail = (): never => { throw new MoldeskError({ code: "IPSAE_NO_RESULT", message: "ipSAE did not produce the expected directional and max rows.", remediation: "Inspect the saved scoring artifacts and diagnostics." }); };
  if (!header || new Set(header).size !== header.length) return fail();
  const rows = lines.filter((row) => row.length === header.length && row[0] !== "Chn1").map((row) => Object.fromEntries(header.map((key, i) => [key, row[i]])));
  if (rows.length !== 3) return fail();
  const score = (a: string, b: string, type: string): number => {
    const found = rows.filter((r) => r.Chn1 === a && r.Chn2 === b && r.Type === type && Number(r.PAE) === pae && Number(r.Dist) === distance);
    const value = Number(found[0]?.ipSAE);
    if (found.length !== 1 || !Number.isFinite(value) || value < 0 || value > 1) return fail();
    return value;
  };
  const forward = score(target, binder, "asym");
  const reverse = score(binder, target, "asym");
  const max = score(...[target, binder].sort() as [string, string], "max");
  if (Math.abs(max - Math.max(forward, reverse)) > 0.000002) return fail();
  return { ipsaeTargetToBinder: forward, ipsaeBinderToTarget: reverse, ipsaeMax: max };
}

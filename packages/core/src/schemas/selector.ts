import { MoldeskError } from "../errors.js";

export type SelectorNamespace = "auth" | "label";

/** A chain, or a residue range within one. `start`/`end` are absent for a whole chain. */
export interface Selector {
  namespace: SelectorNamespace;
  chainId: string;
  start?: number;
  end?: number;
  /** Only for a single-residue selector such as `A:52A`. */
  insertionCode?: string;
}

const CHAIN = /^[A-Za-z0-9]{1,4}$/;
const SINGLE = /^(-?\d+)([A-Z])?$/; // PDB insertion codes are uppercase
const RANGE = /^(-?\d+)-(-?\d+)$/;

function invalid(text: string): MoldeskError {
  return new MoldeskError({
    code: "INVALID_SELECTOR",
    message: `Invalid selector "${text}".`,
    remediation: "Use A, A:45, A:40-60 or A:52A (chain, optional residue number, range or insertion code).",
  });
}

/** Parses `A`, `A:45`, `A:40-60` or `A:52A`. Throws INVALID_SELECTOR (exit 2) on anything else. */
export function parseSelector(text: string, namespace: SelectorNamespace = "auth"): Selector {
  const [chainId, rest, ...extra] = text.split(":");
  if (!chainId || !CHAIN.test(chainId) || extra.length > 0) throw invalid(text);
  if (rest === undefined) return { namespace, chainId };

  const range = RANGE.exec(rest);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end) throw invalid(text);
    return { namespace, chainId, start, end };
  }
  const single = SINGLE.exec(rest);
  if (!single) throw invalid(text);
  const residue = Number(single[1]);
  return {
    namespace,
    chainId,
    start: residue,
    end: residue,
    ...(single[2] ? { insertionCode: single[2] } : {}),
  };
}

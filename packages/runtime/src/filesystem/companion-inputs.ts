import fs from "node:fs";
import path from "node:path";
import { MoldeskError } from "@moldesk/registry";

/** A single companion-file reference an adapter extracted from a job file (e.g.
 * DiffDock-L's `proteinPath`/`ligand.path`). `id` namespaces the staged copy on
 * disk and must be a safe, unique-per-call directory-segment identifier — it is
 * adapter-controlled (a fixed string like `"protein"`), never derived from user
 * input, but is still validated defensively since it becomes a path segment. */
export interface CompanionInputRef {
  id: string;
  sourcePath: string;
}

export interface StagedCompanionInputPath {
  id: string;
  originalPath: string;
  storedPath: string;
}

export interface StageCompanionInputsParams {
  /** Absolute (or resolvable) path of the submitted job file; relative `sourcePath`
   * references are resolved against its directory. */
  jobFilePath: string;
  refs: CompanionInputRef[];
  /** The run's `input/` directory. Must already exist. */
  inputDir: string;
  /** Confinement boundary for every resolved reference. Defaults to
   * `path.dirname(jobFilePath)` — the job file's own directory — so a job cannot
   * reference arbitrary filesystem locations outside where it itself lives. */
  allowedRoot?: string;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function companionError(code: string, message: string, remediation: string, details?: Record<string, unknown>): MoldeskError {
  return new MoldeskError({ code, message, remediation, details });
}

/**
 * True when `target` (already `path.resolve`d) is `root` itself or strictly
 * inside it. Uses `path.relative`, not `string.startsWith(root)` — a prefix
 * check would incorrectly accept a sibling directory like `/allowed-root-evil`
 * when `root` is `/allowed-root`, since the string literally starts with that
 * prefix. `path.relative` returns a `..`-leading (or absolute, on Windows
 * across drives) path whenever `target` escapes `root`, regardless of any
 * shared string prefix.
 */
function isWithinRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolves and validates one companion-file reference against `allowedRoot`,
 * re-checking existence/type/symlink-target on every call rather than trusting
 * any earlier inspection — this is what makes the check effective immediately
 * before staging, not just at an earlier "discovery" step, narrowing (though
 * not eliminating) the TOCTOU window between an adapter resolving a reference
 * and this module copying it.
 *
 * `allowedRootReal` must already be `fs.realpathSync`-canonicalized by the
 * caller (once, not per-ref). The boundary check runs against the fully
 * canonicalized path, not just the lexical one — a symlink escape is not only
 * possible at the final path component. If an ANCESTOR directory in the
 * reference is itself a symlink pointing outside `allowedRoot` (e.g.
 * `sub/file.pdb` where `allowedRoot/sub` is a symlink to `/etc`), the OS
 * silently resolves that ancestor symlink during ordinary path traversal —
 * `lstat` on the leaf alone would report the real target file directly and
 * never show a symlink at all, so checking only "is the final component a
 * symlink" misses this entirely. `fs.realpathSync` on the *complete* resolved
 * path canonicalizes every symlink in the chain (leaf and every ancestor
 * alike), which is why it always runs here rather than being gated behind an
 * `lstat().isSymbolicLink()` check on just the leaf.
 */
function resolveCompanionSource(ref: CompanionInputRef, allowedRoot: string, allowedRootReal: string): string {
  const resolved = path.isAbsolute(ref.sourcePath)
    ? path.resolve(ref.sourcePath)
    : path.resolve(allowedRoot, ref.sourcePath);

  // Cheap lexical pre-check — catches obvious ../ traversal before touching
  // the filesystem at all. Not sufficient on its own (see doc comment above),
  // hence the canonical re-check below.
  if (!isWithinRoot(allowedRoot, resolved)) {
    throw companionError(
      "UNSAFE_COMPANION_INPUT_PATH",
      `Companion input "${ref.id}" resolves outside the allowed source tree: ${resolved}.`,
      "Reference only files within the job file's own directory tree.",
      { id: ref.id, sourcePath: ref.sourcePath, resolved, allowedRoot },
    );
  }

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw companionError(
      "INVALID_RUN_INPUT",
      `Companion input "${ref.id}" not found: ${resolved}.`,
      "Check the referenced path exists and retry.",
      { id: ref.id, sourcePath: ref.sourcePath, resolved },
    );
  }

  if (!isWithinRoot(allowedRootReal, real)) {
    throw companionError(
      "UNSAFE_COMPANION_INPUT_PATH",
      `Companion input "${ref.id}" escapes the allowed source tree via a symlink (in the file itself or an ancestor directory): ${resolved} -> ${real}.`,
      "Reference only real files within the job file's own directory tree; do not use symlinks (directly or via a symlinked parent directory) that point outside it.",
      { id: ref.id, resolved, real, allowedRootReal },
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw companionError(
      "INVALID_RUN_INPUT",
      `Companion input "${ref.id}" not found: ${real}.`,
      "Check the referenced path exists and retry.",
      { id: ref.id, resolved: real },
    );
  }
  if (!stat.isFile()) {
    throw companionError(
      "UNSAFE_COMPANION_INPUT_TYPE",
      `Companion input "${ref.id}" is not a regular file: ${real}.`,
      "Reference a regular file, not a directory, socket, or device.",
      { id: ref.id, resolved: real },
    );
  }

  return real;
}

/**
 * Safely copies one or more adapter-declared companion files (e.g. DiffDock-L's
 * protein PDB and ligand file) into a run's `input/` directory, confined to
 * `allowedRoot`. Generic across models — job-format-specific reference
 * extraction stays in the adapter (`ModelAdapterDefinition.resolveCompanionInputs`);
 * this module only validates and copies.
 */
export function stageCompanionInputs(params: StageCompanionInputsParams): StagedCompanionInputPath[] {
  const { jobFilePath, refs, inputDir } = params;
  const allowedRoot = path.resolve(params.allowedRoot ?? path.dirname(jobFilePath));
  let allowedRootReal: string;
  try {
    allowedRootReal = fs.realpathSync(allowedRoot);
  } catch {
    throw companionError(
      "UNSAFE_COMPANION_INPUT_PATH",
      `Allowed source root does not exist: ${allowedRoot}.`,
      "This is a MoleculeDesk bug — report it; the job file's own directory should always exist.",
      { allowedRoot },
    );
  }

  const seenIds = new Set<string>();
  for (const ref of refs) {
    if (!SAFE_ID_PATTERN.test(ref.id)) {
      throw companionError(
        "UNSAFE_COMPANION_INPUT_ID",
        `Unsafe companion input id: ${JSON.stringify(ref.id)}.`,
        "This is a MoleculeDesk adapter bug — report it; ids must match [A-Za-z0-9_-]+.",
        { id: ref.id },
      );
    }
    if (seenIds.has(ref.id)) {
      throw companionError(
        "DUPLICATE_STAGED_INPUT",
        `Duplicate companion input id: "${ref.id}".`,
        "This is a MoleculeDesk adapter bug — report it; each companion input id must be unique.",
        { id: ref.id },
      );
    }
    seenIds.add(ref.id);
  }

  const staged: StagedCompanionInputPath[] = [];
  for (const ref of refs) {
    // Resolve/validate immediately before copying — see resolveCompanionSource's doc.
    const sourceFile = resolveCompanionSource(ref, allowedRoot, allowedRootReal);
    const destDir = path.join(inputDir, ref.id);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, path.basename(sourceFile));
    try {
      fs.copyFileSync(sourceFile, destFile, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw companionError(
          "STAGED_INPUT_DESTINATION_EXISTS",
          `Refusing to overwrite an existing staged destination for companion input "${ref.id}": ${destFile}.`,
          "This is a MoleculeDesk bug — report it; each run directory should be freshly allocated.",
          { id: ref.id, destFile },
        );
      }
      throw error;
    }
    staged.push({ id: ref.id, originalPath: sourceFile, storedPath: destFile });
  }
  return staged;
}

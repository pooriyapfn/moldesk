import { asMoldeskError } from "@moldesk/core";

/** Exit codes for report commands: 2 = usage/invalid report or input, 8 = cancelled, 10 = internal. */
const EXIT_CODES: Record<string, number> = {
  INVALID_VIEW_INPUT: 2,
  INVALID_REPORT: 2,
  OUTPUT_EXISTS: 2,
  UNSUPPORTED_REPORT: 2,
  REPORT_CONFLICT: 2,
  INVALID_SELECTOR: 2,
  INVALID_ENVELOPE: 2,
  UNKNOWN_SCHEMA_KIND: 2,
  VIEW_CANCELLED: 8,
};

/** Prints an error as JSON (stdout, one object) or text (stderr) and sets the exit code. */
export function reportFailure(error: unknown, json: boolean | undefined): void {
  const err = asMoldeskError(error);
  if (json) {
    console.log(JSON.stringify({ status: "error", code: err.code, message: err.message, remediation: err.remediation }, null, 2));
  } else {
    console.error(err.message);
    if (err.remediation) console.error(err.remediation);
  }
  process.exitCode = EXIT_CODES[err.code] ?? 10;
}

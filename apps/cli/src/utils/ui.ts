import logo from "cli-ascii-logo";

const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const wordmark = logo.createLogo("MolDesk", "ocean");

function color(code: number, value: string): string {
  return useColor ? `\u001B[${code}m${value}\u001B[0m` : value;
}

export function accent(value: string): string {
  return color(36, value);
}

export function strong(value: string): string {
  return color(1, value);
}

export function success(value: string): string {
  return color(32, value);
}

export function failure(value: string): string {
  return color(31, value);
}

export function printWelcome(): void {
  console.log(
    [
      useColor ? wordmark : wordmark.replace(ANSI_ESCAPE, ""),
      "",
      "  Welcome to MolDesk",
      "",
    ].join("\n"),
  );
}

export function humanize(value: string): string {
  const modelNames: Record<string, string> = {
    proteinmpnn: "ProteinMPNN",
    ligandmpnn: "LigandMPNN",
    boltz: "Boltz",
  };
  if (modelNames[value.toLowerCase()]) return modelNames[value.toLowerCase()]!;
  const words = value.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}

export interface ProgressLine {
  update(message: string): void;
  finish(): void;
}

/** Keeps frequently-updated progress on one terminal line. */
export function createProgressLine(): ProgressLine {
  let active = false;
  let lastMessage = "";
  let lastPhase = "";

  return {
    update(message: string): void {
      if (message === lastMessage) return;
      lastMessage = message;

      if (process.stdout.isTTY) {
        process.stdout.write(`\r\u001B[2K  ${accent("●")} ${message}`);
        active = true;
      } else {
        // Logs cannot redraw a line, so show each phase once instead of every
        // downloaded chunk.
        const phase = message.replace(/\s+\d+%$/, "");
        if (phase !== lastPhase) {
          console.log(`  • ${message}`);
          lastPhase = phase;
          active = true;
        }
      }
    },
    finish(): void {
      if (active && process.stdout.isTTY) process.stdout.write("\r\u001B[2K");
      active = false;
      lastMessage = "";
      lastPhase = "";
    },
  };
}

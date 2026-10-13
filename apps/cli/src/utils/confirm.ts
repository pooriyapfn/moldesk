import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Asks a yes/no question on stderr (stdout stays machine-readable). Anything but y/yes declines. */
export function confirm(question: string, io: { input?: Readable; output?: Writable } = {}): Promise<boolean> {
  const rl = readline.createInterface({ input: io.input ?? process.stdin, output: io.output ?? process.stderr, terminal: false });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(`${question} [y/N] `, (answer) => {
      answered = true;
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
    rl.once("close", () => {
      if (!answered) resolve(false);
    });
  });
}

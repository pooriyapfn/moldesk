import type { Readable, Writable } from "node:stream";

interface TtyInput extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

export interface ReadSecretOptions {
  input: TtyInput;
  /** Prompt and newline go here (stderr), never the secret. */
  output: Writable;
  prompt: string;
}

/**
 * Reads one secret without echoing it. On a terminal, characters are collected in raw mode and
 * nothing is printed back. On a pipe, the first line is taken. The secret is never an argument.
 */
export function readSecret({ input, output, prompt }: ReadSecretOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let buffer = "";
    const interactive = input.isTTY === true && typeof input.setRawMode === "function";
    if (interactive) input.setRawMode!(true);
    input.resume();
    input.setEncoding?.("utf8");

    const finish = (action: () => void): void => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      if (interactive) input.setRawMode!(false);
      input.pause();
      output.write("\n");
      action();
    };
    const onEnd = (): void => finish(() => resolve(buffer.replace(/\r?\n.*$/s, "")));
    const onError = (error: Error): void => finish(() => reject(error));
    const onData = (chunk: string | Buffer): void => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") return finish(() => reject(new Error("Cancelled.")));
        if (char === "\r" || char === "\n") return finish(() => resolve(buffer));
        if (interactive && (char === "\u007f" || char === "\b")) buffer = buffer.slice(0, -1);
        else buffer += char;
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readSecret } from "./secret-input.js";

function tty() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void; raw: boolean[] };
  input.isTTY = true;
  input.raw = [];
  input.setRawMode = (mode) => void input.raw.push(mode);
  return input;
}

describe("readSecret", () => {
  it("never echoes typed characters and restores raw mode (interactive)", async () => {
    const input = tty();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk) => written.push(chunk.toString()));
    const pending = readSecret({ input, output, prompt: "key: " });
    input.write("abc");
    input.write("\u007fd12345\r");
    expect(await pending).toBe("abd12345");
    expect(written.join("")).toBe("key: \n");
    expect(input.raw).toEqual([true, false]);
  });

  it("rejects on Ctrl-C", async () => {
    const input = tty();
    const pending = readSecret({ input, output: new PassThrough(), prompt: "k: " });
    input.write("ab\u0003");
    await expect(pending).rejects.toThrow("Cancelled.");
    expect(input.raw).toEqual([true, false]);
  });

  it("takes the first line from a pipe and ignores the rest", async () => {
    const input = new PassThrough();
    const pending = readSecret({ input, output: new PassThrough(), prompt: "k: " });
    input.end("first-line-key\nsecond\n");
    expect(await pending).toBe("first-line-key");
  });

  it("returns what was received when a pipe ends without a newline", async () => {
    const input = new PassThrough();
    const pending = readSecret({ input, output: new PassThrough(), prompt: "k: " });
    input.end("only-key");
    expect(await pending).toBe("only-key");
  });
});

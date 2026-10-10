import { describe, expect, it } from "vitest";
import { openInBrowser } from "./open.js";

describe("openInBrowser", () => {
  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)("uses %s -> %s with the path as one argument", async (platform, exe) => {
    const calls: Array<[string, string[]]> = [];
    const hostile = "-evil $(touch /tmp/pwned) `x` 'q' \"d\" ü.html";
    const result = await openInBrowser(hostile, {
      platform,
      run: async (c, a) => {
        calls.push([c, a]);
        return { code: 0, stderr: "" };
      },
    });
    expect(result).toEqual({ opened: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(exe);
    expect(calls[0][1]).toHaveLength(1);
    expect(calls[0][1][0].startsWith("/")).toBe(true);
    expect(calls[0][1][0].endsWith(hostile)).toBe(true);
  });

  it("reports failures instead of throwing", async () => {
    expect((await openInBrowser("/a.html", { platform: "linux", run: async () => ({ code: 3, stderr: "no display\n" }) })).error).toBe("no display");
    expect((await openInBrowser("/a.html", { platform: "linux", run: async () => { throw new Error("ENOENT"); } })).error).toBe("ENOENT");
    expect((await openInBrowser("/a.html", { platform: "win32" })).opened).toBe(false);
  });
});

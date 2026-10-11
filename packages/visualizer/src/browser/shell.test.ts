import { describe, expect, it } from "vitest";
import { reportPathFromLocation, shellQuote, updateCommand } from "./shell";

const file = (pathname: string, host = "") => ({ protocol: "file:", host, pathname });

describe("shellQuote", () => {
  it.each([
    ["/a/b.html", "'/a/b.html'"],
    ["/with space/it's.html", `'/with space/it'\\''s.html'`],
    ["/$(rm -rf ~)/`x`.html", "'/$(rm -rf ~)/`x`.html'"],
    ["-rf", "'-rf'"],
    ["/ünï/日本.html", "'/ünï/日本.html'"],
  ])("quotes %s", (input, expected) => expect(shellQuote(input)).toBe(expected));
});

describe("reportPathFromLocation", () => {
  it("decodes a plain local file URL", () => {
    expect(reportPathFromLocation(file("/Users/me/my%20report.html"))).toBe("/Users/me/my report.html");
  });

  it.each([
    ["http page", { protocol: "https:", host: "x", pathname: "/a.html" }],
    ["network file host", file("/share/a.html", "server")],
    ["windows drive", file("/C:/a.html")],
    ["bad escape", file("/%E0%A4%A.html")],
    ["NUL byte", file("/a%00b.html")],
  ])("keeps the placeholder for %s", (_n, loc) => {
    expect(reportPathFromLocation(loc)).toBe("/path/to/report.html");
  });

  it("builds the documented command", () => {
    expect(updateCommand(file("/tmp/r.html"))).toBe("moldesk visualizer update '/tmp/r.html'");
  });
});

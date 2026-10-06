import fs from "node:fs";

// Read from this package's own package.json (one level above both src/ and dist/)
// so the reported version can never drift from the published one. A hard-coded
// constant was missed by the 0.0.2 bump and made `moldesk --version` print 0.0.1.
function readVersion(): string {
  const manifest = new URL("../package.json", import.meta.url);
  return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version;
}

export const VERSION = readVersion();

import { createHash } from "node:crypto";
import fs from "node:fs";

/** Stable sha256 digest of a JSON-serializable value. Shared by installation and run provenance. */
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** sha256 of a file's contents, streamed rather than loaded fully into memory. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

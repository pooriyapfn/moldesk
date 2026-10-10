// Locates and verifies the installed viewer bundle (built once at package build time).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const TEMPLATE_VERSION = 1;
export const ASSET_NAMES = ["viewer.css", "viewer.js"] as const; // explicit digest order

export interface BundleMetadata {
  viewerVersion: string;
  molstarVersion: string;
  templateVersion: number;
  compatible: { envelopeVersions: number[]; schemaVersions: number[] };
  assets: Record<(typeof ASSET_NAMES)[number], string>;
  bundleSha256: string;
}

export interface ViewerBundle {
  metadata: BundleMetadata;
  js: string;
  css: string;
}

export class BundleError extends Error {
  readonly code = "VISUALIZER_BUNDLE_INVALID";
  constructor(message: string) {
    super(
      `${message}. The installed MoleculeDesk viewer is missing or damaged; reinstall it with "npm install -g @moldesk/cli".`,
    );
    this.name = "BundleError";
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function computeBundleSha256(assets: Record<string, string>): string {
  const lines = ASSET_NAMES.map((name) => `${name}:${assets[name]}\n`).join("");
  return sha256Hex(lines);
}

export function defaultAssetsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
}

export function loadBundle(assetsDir: string = defaultAssetsDir()): ViewerBundle {
  let metadata: BundleMetadata;
  let js: string;
  let css: string;
  try {
    metadata = JSON.parse(readFileSync(path.join(assetsDir, "bundle.json"), "utf8")) as BundleMetadata;
    js = readFileSync(path.join(assetsDir, "viewer.js"), "utf8");
    css = readFileSync(path.join(assetsDir, "viewer.css"), "utf8");
  } catch {
    throw new BundleError("Could not read viewer assets");
  }
  const actual = { "viewer.js": sha256Hex(js), "viewer.css": sha256Hex(css) };
  if (
    !metadata?.assets ||
    metadata.assets["viewer.js"] !== actual["viewer.js"] ||
    metadata.assets["viewer.css"] !== actual["viewer.css"] ||
    metadata.bundleSha256 !== computeBundleSha256(actual)
  ) {
    throw new BundleError("Viewer assets do not match their recorded digests");
  }
  if (metadata.templateVersion !== TEMPLATE_VERSION) {
    throw new BundleError("Viewer assets were built for a different report template");
  }
  return { metadata, js, css };
}

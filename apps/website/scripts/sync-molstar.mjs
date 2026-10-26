// The RFD4-Proteina guide embeds the prebuilt Mol* viewer (https://molstar.org, MIT). It is a 5 MB script,
// so it is copied from the pinned `molstar` dependency into public/vendor/molstar at build time instead of
// being committed. The page loads it only when the viewer scrolls into view and falls back to a small
// canvas view if it is missing.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../public/vendor/molstar");
const require = createRequire(import.meta.url);

let root;
try {
  root = path.dirname(require.resolve("molstar/package.json"));
} catch {
  console.warn("molstar is not installed; the 3D cartoon viewer will fall back to the canvas view.");
  process.exit(0);
}

const files = [
  ["build/viewer/molstar.js", "molstar.js"],
  ["build/viewer/theme/light.css", "light.css"],
  ["LICENSE", "LICENSE.txt"],
];
fs.mkdirSync(target, { recursive: true });
let copied = 0;
for (const [from, to] of files) {
  const source = path.join(root, from);
  const dest = path.join(target, to);
  if (!fs.existsSync(source)) {
    console.warn(`Missing ${from} in molstar; skipping.`);
    continue;
  }
  const wanted = fs.readFileSync(source);
  if (!fs.existsSync(dest) || !wanted.equals(fs.readFileSync(dest))) {
    fs.writeFileSync(dest, wanted);
    copied += 1;
  }
}
if (copied > 0) console.log(`Copied ${copied} Mol* file(s) to public/vendor/molstar`);

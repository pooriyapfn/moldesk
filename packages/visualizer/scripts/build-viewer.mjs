// Builds the viewer once at package build time. Never runs when reports are generated.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "assets");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const molstarDir = path.dirname(
  // molstar has no "exports" map, so its package.json is resolvable.
  fileURLToPath(import.meta.resolve("molstar/package.json")),
);
const molstarPkg = JSON.parse(readFileSync(path.join(molstarDir, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "src/browser/main.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  jsx: "automatic",
  write: false,
  outdir: out,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', "process.env.DEBUG": "false" },
  loader: { ".css": "empty" },
  logLevel: "warning",
});

let js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
// The bundle is inlined in a <script>; make sure nothing can terminate or open an HTML comment.
js = js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
if (/<\/script/i.test(js)) throw new Error("viewer bundle still contains </script");

const css =
  readFileSync(path.join(molstarDir, "build/viewer/theme/light.css"), "utf8") +
  "\n" +
  readFileSync(path.join(root, "src/browser/styles.css"), "utf8");
if (/@import|url\(\s*["']?(https?:|\/\/)/i.test(css)) throw new Error("viewer CSS references a remote resource");
if (/<\/style/i.test(css)) throw new Error("viewer CSS contains </style");

writeFileSync(path.join(out, "viewer.js"), js);
writeFileSync(path.join(out, "viewer.css"), css);

const assets = { "viewer.css": sha(css), "viewer.js": sha(js) };
const bundleSha256 = sha(`viewer.css:${assets["viewer.css"]}\nviewer.js:${assets["viewer.js"]}\n`);
writeFileSync(
  path.join(out, "bundle.json"),
  JSON.stringify(
    {
      viewerVersion: pkg.version,
      molstarVersion: molstarPkg.version,
      templateVersion: 1,
      compatible: { envelopeVersions: [1], schemaVersions: [1] },
      assets,
      bundleSha256,
    },
    null,
    2,
  ) + "\n",
);

copyFileSync(path.join(molstarDir, "LICENSE"), path.join(out, "MOLSTAR_LICENSE.txt"));
writeFileSync(
  path.join(out, "THIRD_PARTY_NOTICES.txt"),
  `The MoleculeDesk report viewer bundles:\n\n- Mol* ${molstarPkg.version} (MIT) — https://molstar.org\n  See MOLSTAR_LICENSE.txt.\n- React ${JSON.parse(readFileSync(path.join(root, "node_modules/react/package.json"), "utf8")).version} (MIT)\n`,
);

const remote = [...new Set(js.match(/https?:\/\/[^\s"'`)\\]+/g) ?? [])];
console.log(`viewer.js ${(js.length / 1024 / 1024).toFixed(2)} MiB, viewer.css ${(css.length / 1024).toFixed(0)} KiB`);
console.log(`bundleSha256 ${bundleSha256}`);
console.log(`${remote.length} URL literals in bundle (inert strings; network behaviors are removed from the plugin spec)`);

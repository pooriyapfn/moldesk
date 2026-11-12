import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv from "ajv";
import { parse } from "yaml";

const git = promisify(execFile);
const repository = "https://github.com/pooriyapfn/bio-challenges";
const output = fileURLToPath(new URL("../src/generated/", import.meta.url));
const localDirectory = process.env.BIO_CHALLENGES_DIR;
const ref = process.env.BIO_CHALLENGES_REF ?? "main";
const temporaryDirectory = localDirectory ? null : await mkdtemp(join(tmpdir(), "bio-challenges-"));
const source = localDirectory ? resolve(localDirectory) : join(temporaryDirectory, "source");

try {
  if (!localDirectory) {
    await git("git", [
      "clone", "--depth=1", "--single-branch", "--no-tags", "--filter=blob:none", "--sparse",
      `--branch=${ref}`, `${repository}.git`, source,
    ]);
    await git("git", ["-C", source, "sparse-checkout", "set", "competitions", "schemas"]);
  }

  const { stdout } = await git("git", ["-C", source, "rev-parse", "HEAD"]);
  const revision = stdout.trim();
  const catalog = await readCatalog(source);

  await mkdir(output, { recursive: true });
  const stagingFile = join(output, `competitions.${process.pid}.tmp`);
  try {
    await writeFile(stagingFile, JSON.stringify({ revision, competitions: catalog }));
    await rename(stagingFile, join(output, "competitions.json"));
  } finally {
    await rm(stagingFile, { force: true });
  }
  console.log(`Imported ${catalog.length} competitions from bio-challenges at ${revision}.`);
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}

async function readCatalog(root) {
  const schemas = join(root, "schemas");
  const directory = join(root, "competitions");
  for (const path of [schemas, directory]) {
    if (!(await lstat(path)).isDirectory()) throw new Error(`${path} must be a directory.`);
  }

  const schema = JSON.parse(await readRegularFile(join(schemas, "competition.schema.json")));
  const validator = new Ajv({ allErrors: true, format: "full" });
  const validate = validator.compile(schema);
  const folders = await readdir(directory, { withFileTypes: true });
  if (folders.length === 0) throw new Error("The bio-challenges catalog is empty.");

  const competitions = [];
  for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = join(directory, folder.name);
    if (!folder.isDirectory()) throw new Error(`${path} must be a directory.`);

    const metadata = parse(await readRegularFile(join(path, "competition.yaml")), { maxAliasCount: 0 });
    if (!validate(metadata)) throw new Error(`${path}: ${validator.errorsText(validate.errors)}`);
    if (metadata.slug !== folder.name) throw new Error(`${path}: slug must match the folder name.`);
    const readme = await readRegularFile(join(path, "README.md"));
    competitions.push(toCompetition(metadata, readme, path));
  }
  return competitions;
}

function toCompetition(metadata, readme, path) {
  const [title, summary, heading, ...guide] = readme.trim().split(/\r?\n[ \t]*\r?\n/);
  if (!title?.startsWith("# ") || !summary?.trim() || heading?.trim() !== "## How to start" || !guide[0]?.trim()) {
    throw new Error(`${path}: README needs a title, a summary, and a How to start section.`);
  }

  let milestone;
  if (metadata.deadline) {
    const { at, day, label, time_zone: timeZone } = metadata.deadline;
    const formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const deadlineDay = day ?? formatter.format(new Date(at));
    if (metadata.opens_on && metadata.opens_on > deadlineDay) {
      throw new Error(`${path}: opens_on falls after the deadline.`);
    }
    milestone = at ? { at, label, timeZone } : { day, label, timeZone };
  }

  return {
    summary: {
      slug: metadata.slug,
      name: metadata.title,
      organizer: metadata.organizer,
      targets: metadata.targets,
      actions: metadata.actions,
      description: summary.trim().replace(/\s+/g, " "),
      reference: { label: metadata.source_label ?? "Official competition page", url: metadata.source_url },
      opensOn: metadata.opens_on,
      milestone,
      gettingStarted: guide[0].trim().replace(/\s+/g, " "),
      entry: metadata.entry,
      solutions: metadata.solutions,
    },
    guide: guide.join("\n\n"),
    lastVerified: metadata.last_verified,
  };
}

async function readRegularFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`${path} must be a regular file.`);
  return readFile(path, "utf8");
}

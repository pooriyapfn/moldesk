#!/usr/bin/env node
// Checks that every `moldesk` command and flag the agent skill mentions exists in the real CLI's `--help`,
// and that every CLI command is documented in references/cli.md. Uses the built CLI (run `pnpm build` first).
//
//   node scripts/check-skill-commands.mjs [--cli apps/cli/dist/index.js] [--skill plugins/moldesk/skills/moldesk]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** Command words and option names from one `--help` text (commander's layout). */
export function parseHelp(text) {
  const commands = new Set();
  const options = new Set();
  let section = "";
  for (const line of text.split("\n")) {
    if (/^(Options|Commands|Arguments):/.test(line)) {
      section = line.split(":")[0];
      continue;
    }
    if (!line.startsWith("  ")) {
      if (line.trim() !== "") section = "";
      continue;
    }
    if (section === "Commands") {
      const m = /^ {2}([a-z][a-z0-9-]*)\b/.exec(line);
      if (m && m[1] !== "help") commands.add(m[1]);
    } else if (section === "Options") {
      // "  -V, --version  text" / "  --highlight <selector>  text"; wrapped description lines are indented deeper.
      const head = /^ {2}((?:-[A-Za-z], )?--?[A-Za-z][\w-]*(?:, --[\w-]+)?)/.exec(line);
      if (head) for (const name of head[1].match(/--?[A-Za-z][\w-]*/g)) options.add(name);
    }
  }
  return { commands, options };
}

/** A `helpFor(path)` that runs the real CLI once per command path. */
export function cliHelp(cli) {
  const cache = new Map();
  return (commandPath) => {
    const key = commandPath.join(" ");
    if (!cache.has(key)) {
      let text;
      try {
        text = execFileSync(process.execPath, [cli, ...commandPath, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        return undefined;
      }
      cache.set(key, parseHelp(text));
    }
    return cache.get(key);
  };
}

/** Every command line and flag the markdown mentions, with its line number and the command it sits under. */
export function extractMentions(markdown) {
  const mentions = [];
  const lines = markdown.split("\n");
  let fenced = false;
  let context = null; // command path of the nearest heading that names one
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      let text = line.trim().replace(/^\$\s+/, "");
      while (text.endsWith("\\") && i + 1 < lines.length) text = `${text.slice(0, -1)} ${lines[++i].trim()}`;
      if (/^moldesk(\s|$)/.test(text)) mentions.push({ line: i + 1, kind: "command", text: text.replace(/\s#(\s.*)?$/, "") });
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const span = /`(moldesk(?:\s[^`]*)?)`/.exec(line);
      context = span ? commandWords(span[1]) : null;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const text = match[1].trim();
      if (/^moldesk(\s|$)/.test(text)) mentions.push({ line: i + 1, kind: "command", text });
      else if (/^--?[A-Za-z]/.test(text)) mentions.push({ line: i + 1, kind: "flag", text, context });
    }
  }
  return mentions;
}

/** The leading command words of `moldesk run <model> [options]`: ["run"]. */
function commandWords(text) {
  const words = [];
  for (const token of text.split(/\s+/).slice(1)) {
    if (!/^[a-z][a-z0-9-]*$/.test(token)) break;
    words.push(token);
  }
  return words;
}

function checkFlag(flag, help, where, errors, scope) {
  const name = flag.replace(/^(--?[A-Za-z][\w-]*).*$/, "$1");
  if (!help.options.has(name)) errors.push(`${where}: ${name} is not an option of ${scope}`);
}

/**
 * Checks one document. `helpFor(path)` returns `{ commands, options }` for a command path, or undefined when the
 * command does not exist. Returns { errors, commands } where `commands` are the top-level commands mentioned.
 */
export function checkMarkdown(file, markdown, helpFor) {
  const errors = [];
  const mentioned = new Set();
  const rootHelp = helpFor([]);
  const allOptions = () => new Set([...rootHelp.options, ...[...rootHelp.commands].flatMap((c) => [...(helpFor([c])?.options ?? [])])]);
  for (const m of extractMentions(markdown)) {
    const where = `${file}:${m.line}`;
    if (m.kind === "flag") {
      const help = m.context?.length ? helpFor(m.context) : undefined;
      if (help) checkFlag(m.text, help, where, errors, `moldesk ${m.context.join(" ")}`);
      else if (!allOptions().has(m.text.replace(/^(--?[A-Za-z][\w-]*).*$/, "$1"))) errors.push(`${where}: ${m.text.split(/[\s=]/)[0]} is not an option of any moldesk command`);
      continue;
    }
    const tokens = m.text.split(/\s+/).slice(1);
    const walked = [];
    let descending = true;
    for (const raw of tokens) {
      const token = raw.replace(/^\[+/, ""); // `[--yes]` is an optional flag
      if (token.startsWith("-")) {
        const help = helpFor(walked) ?? rootHelp;
        checkFlag(token, help, where, errors, walked.length ? `moldesk ${walked.join(" ")}` : "moldesk");
        continue;
      }
      if (!descending || !/^[a-z][a-z0-9-]*$/.test(token)) {
        descending = false;
        continue;
      }
      const help = helpFor(walked) ?? rootHelp;
      if (help.commands.has(token)) {
        walked.push(token);
      } else if (help.commands.size > 0) {
        errors.push(`${where}: "${token}" is not a ${walked.length ? `subcommand of moldesk ${walked.join(" ")}` : "moldesk command"}`);
        descending = false;
      } else {
        descending = false; // a positional argument such as a model name
      }
    }
    if (walked.length > 0) mentioned.add(walked[0]);
  }
  return { errors, commands: mentioned };
}

export function checkSkill(skillDir, helpFor) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(skillDir);
  const errors = [];
  let cliCommands = new Set();
  for (const file of files.sort()) {
    const result = checkMarkdown(path.relative(root, file), fs.readFileSync(file, "utf8"), helpFor);
    errors.push(...result.errors);
    if (path.basename(file) === "cli.md") cliCommands = result.commands;
  }
  const documented = path.join(skillDir, "references", "cli.md");
  if (!fs.existsSync(documented)) errors.push(`${path.relative(root, documented)}: missing`);
  for (const command of helpFor([]).commands) {
    if (!cliCommands.has(command)) errors.push(`${path.relative(root, documented)}: the CLI has \`moldesk ${command}\` but the reference does not mention it`);
  }
  return { errors, files: files.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? path.resolve(process.argv[i + 1]) : fallback;
  };
  const cli = arg("--cli", path.join(root, "apps/cli/dist/index.js"));
  const skill = arg("--skill", path.join(root, "plugins/moldesk/skills/moldesk"));
  if (!fs.existsSync(cli)) {
    console.error(`The CLI is not built (${cli}). Run \`pnpm build\` first.`);
    process.exit(2);
  }
  const { errors, files } = checkSkill(skill, cliHelp(cli));
  if (errors.length > 0) {
    console.error(`${errors.length} problem(s) in the agent skill:\n${errors.map((e) => `  ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Agent skill OK: every moldesk command and flag in ${files} files exists, and every command is documented.`);
}

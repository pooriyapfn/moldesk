import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkMarkdown, checkSkill, extractMentions, parseHelp } from "./check-skill-commands.mjs";

const HELP = {
  "": { commands: ["run", "cloud", "view"], options: ["-V", "--version", "-h", "--help"] },
  run: { commands: [], options: ["--output", "--param", "--json", "-h", "--help"] },
  view: { commands: [], options: ["--highlight", "--json", "-h", "--help"] },
  cloud: { commands: ["connect", "cache"], options: ["-h", "--help"] },
  "cloud connect": { commands: [], options: ["--json", "-h", "--help"] },
  "cloud cache": { commands: ["list"], options: ["-h", "--help"] },
  "cloud cache list": { commands: [], options: ["--json"] },
};
const helpFor = (p) => {
  const h = HELP[p.join(" ")];
  return h && { commands: new Set(h.commands), options: new Set(h.options) };
};
const check = (md) => checkMarkdown("doc.md", md, helpFor).errors;

test("parseHelp reads commander's commands and options, including short names and wrapped lines", () => {
  const help = parseHelp(`Usage: moldesk [options] [command]

Options:
  -V, --version                        output the version number
  --highlight <selector>  highlight a chain
                          (repeatable)
  -h, --help                           display help for command

Commands:
  doctor [options]                     Check system
                                       compatibility
  cloud                                Connect
  help [command]                       display help for command
`);
  assert.deepEqual([...help.commands].sort(), ["cloud", "doctor"]);
  assert.deepEqual([...help.options].sort(), ["--help", "--highlight", "--version", "-V", "-h"]);
});

test("accepts real commands, subcommands, positional arguments, flags and comments", () => {
  const md = [
    "# Doc",
    "Run `moldesk run boltz input.yaml --output ./out --param seed=1`.",
    "```bash",
    "moldesk view s.pdb --highlight A:1 --json   # a note with --not-checked",
    "$ moldesk cloud connect runpod --json",
    "moldesk cloud cache list --json",
    "moldesk --version",
    "curl -O https://example.org/x.pdb --whatever",
    "moldesk run boltz in.yaml \\",
    "  --output ./results",
    "```",
  ].join("\n");
  assert.deepEqual(check(md), []);
});

test("rejects an unknown command, subcommand and flag, with the line number", () => {
  const errors = check("`moldesk explode now`\n\n`moldesk cloud destroy`\n\n```\nmoldesk run m i --nope\nmoldesk cloud connect x --bad\n```\n");
  assert.deepEqual(errors, [
    'doc.md:1: "explode" is not a moldesk command',
    'doc.md:3: "destroy" is not a subcommand of moldesk cloud',
    "doc.md:6: --nope is not an option of moldesk run",
    "doc.md:7: --bad is not an option of moldesk cloud connect",
  ]);
});

test("checks a flag against the command named by the nearest heading, and against any command otherwise", () => {
  const md = "## `moldesk run <model> [options]`\n\n| `--output <dir>` | ok |\n| `--highlight <x>` | belongs to view, not run |\n\n## Other\n\nUse `--highlight` or `--bogus` here.\n";
  assert.deepEqual(check(md), [
    "doc.md:4: --highlight is not an option of moldesk run",
    "doc.md:8: --bogus is not an option of any moldesk command",
  ]);
});

test("checks optional flags written in brackets, as in headings", () => {
  assert.deepEqual(check("## `moldesk run <m> <i> [--output <dir>] [--json]`"), []);
  assert.deepEqual(check("## `moldesk run <m> <i> [--output <dir>] [--nope]`"), ["doc.md:1: --nope is not an option of moldesk run"]);
});

test("a flag value after = or a space is not part of the name", () => {
  assert.deepEqual(check("`moldesk run m i --param=x` and `moldesk run m i --output=dir`"), []);
});

test("extractMentions ignores prose and non-moldesk code", () => {
  assert.deepEqual(extractMentions("The moldesk tool uses `curl` and `pnpm build` and `--` alone.\n"), []);
});

test("checkSkill also requires cli.md to document every command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-check-"));
  fs.mkdirSync(path.join(dir, "references"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "Use `moldesk run m i`.");
  fs.writeFileSync(path.join(dir, "references", "cli.md"), "## `moldesk run <m> <i>`\n\n## `moldesk view [f]`\n");
  const result = checkSkill(dir, helpFor);
  assert.deepEqual(result.errors.map((e) => e.replace(/^.*cli\.md: /, "")), ["the CLI has `moldesk cloud` but the reference does not mention it"]);
  fs.writeFileSync(path.join(dir, "references", "cli.md"), "## `moldesk run`\n\n## `moldesk view`\n\n## `moldesk cloud connect`\n");
  assert.deepEqual(checkSkill(dir, helpFor).errors, []);
});

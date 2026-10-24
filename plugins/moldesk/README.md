# MoleculeDesk agent plugin

One skill, `moldesk`, packaged for both Claude Code and Codex. It teaches a coding agent to install the `moldesk` CLI, check hardware compatibility, prepare inputs, run models, handle cloud runs with explicit cost approval, and fetch, analyze, inspect, highlight and compare protein structures.

## Install

Claude Code:

```bash
claude plugin install moldesk --marketplace pooriyapfn/moldesk
```

On Claude Code older than 2.1.275: `claude plugin marketplace add pooriyapfn/moldesk`, then `claude plugin install moldesk@moldesk`.

Codex:

```bash
codex plugin marketplace add pooriyapfn/moldesk
```

Then enter `/plugins` in Codex and install `moldesk`.

Manual (any agent that reads `SKILL.md` folders): copy `skills/moldesk` into `~/.claude/skills/` (Claude Code) or `~/.agents/skills/` (Codex).

## Layout

```
plugins/moldesk/
  .claude-plugin/plugin.json   Claude Code plugin manifest
  .codex-plugin/plugin.json    Codex plugin manifest
  skills/moldesk/
    SKILL.md                   entry point: rules, core workflow, model picker
    agents/openai.yaml         Codex UI metadata
    references/                loaded on demand
      install.md               installer, MOLDESK_HOME, update, removal
      cli.md                   commands, flags, --json fields, exit codes (every CLI command must appear here)
      compatibility.md         doctor/list, platform matrix, alternatives
      models.md                inputs, params, examples for each model
      workflows.md             multi-step recipes, including fetch -> analyze -> predict -> compare
      cloud-runpod.md          quote, approval, cleanup (Boltz-2, ProteinMPNN, DiffDock-L, OpenDDE)
```

Marketplace catalogs live at the repository root: `.claude-plugin/marketplace.json` (Claude Code) and `.agents/plugins/marketplace.json` (Codex).

## Maintaining

The skill describes real CLI behavior. When a change affects it, update the skill in the same pull request:

- a command, flag, `--json` field, or exit code changes → `references/cli.md`;
- a model is added, promoted, or changes platforms, inputs, or params → `SKILL.md` model table, `references/models.md`, `references/compatibility.md`;
- cloud execution is enabled for a model → `references/cloud-runpod.md` ("Current status").

Bump `version` in both `plugin.json` files when the skill changes, so installed copies update. Validate with:

```bash
claude plugin validate .
pnpm build && node scripts/check-skill-commands.mjs   # from the repository root
```

`scripts/check-skill-commands.mjs` reads every `moldesk` command and `--flag` in the skill's Markdown and checks it against the built CLI's `--help` (including subcommands), and requires `references/cli.md` to mention every CLI command. CI runs it, so a renamed flag or a new command fails the build until the skill is updated.

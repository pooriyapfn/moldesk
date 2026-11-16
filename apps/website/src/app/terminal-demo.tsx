import { BrandIcon, CLAUDE_PATH, OPENAI_PATH, type InstallTarget } from "./install-command";

const examples: Record<InstallTarget, { prompt?: string; lines: string[] }> = {
  terminal: {
    lines: ["$ moldesk install boltz", "✓ Boltz installed successfully", "", "$ moldesk run boltz --input protein.yaml", "✓ Prediction completed", "✓ Protein structure saved", "", "$ moldesk studio", "✓ Open Studio to view your 3D structure"],
  },
  codex: {
    prompt: "Build a reproducible MoleDesk workflow to predict and analyze a protein structure using Boltz. Validate the YAML before running it.",
    lines: ["✓ MoleDesk skill loaded", "✓ Workflow generated: protein-analysis.yaml", "✓ Workflow validated · 2 steps", "✓ Ready to execute"],
  },
  claude: {
    prompt: "Use MoleDesk to create a workflow that predicts a protein structure with Boltz, analyzes the results, and opens it in Studio.",
    lines: ["✓ MoleDesk skill loaded", "✓ Workflow generated: protein-analysis.yaml", "✓ Workflow validated · 2 steps", "✓ Ready to execute"],
  },
};

export function TerminalDemo({ target }: { target: InstallTarget }) {
  const isTerminal = target === "terminal";
  const example = examples[target];
  return (
    <div className={`overflow-hidden rounded-xl border ${isTerminal ? "border-[#27332F] bg-[#0C1110] text-[#F3F7F5]" : "border-border bg-white text-foreground"}`}>
      <div className={`flex h-12 items-center gap-2 border-b px-4 font-mono text-[12px] ${isTerminal ? "border-[#27332F] bg-[#121917] text-[#A7B3AE]" : "border-border text-muted"}`}>
        {isTerminal ? (
          <><span className="size-2 rounded-full bg-[#27332F]" /><span className="size-2 rounded-full bg-[#27332F]" /><span className="size-2 rounded-full bg-[#27332F]" /><span className="ml-2.5">moldesk</span></>
        ) : (
          <><BrandIcon path={target === "claude" ? CLAUDE_PATH : OPENAI_PATH} className={`size-4 ${target === "claude" ? "text-[#D97757]" : "text-foreground"}`} /><span>{target === "claude" ? "claude" : "codex"}</span></>
        )}
      </div>
      <div key={target} aria-live="polite" className="min-h-[330px] px-6 py-6 font-mono text-[13px] leading-[2.05] motion-safe:animate-[md-example-in_400ms_100ms_both]">
        {example.prompt && <p className="mb-6 flex gap-2 text-foreground"><span className="text-accent">&gt;</span><span>{example.prompt}</span></p>}
        {example.lines.map((line, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap break-words motion-safe:animate-[md-line-in_320ms_ease-out_both] ${line.startsWith("✓") ? (isTerminal ? "text-[#59B89A]" : "text-accent") : ""}`}
            style={{ animationDelay: `${(example.prompt ? 900 : 350) + example.lines.slice(0, i).filter(Boolean).length * 700}ms` }}
          >
            {line || "\u00a0"}
          </div>
        ))}
      </div>
    </div>
  );
}

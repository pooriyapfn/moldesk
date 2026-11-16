"use client";

import { useState } from "react";
import { InstallCommand, type InstallTarget } from "./install-command";
import { TerminalDemo } from "./terminal-demo";

export function Hero() {
  const [target, setTarget] = useState<InstallTarget>("claude");
  return (
    <div className="grid items-center gap-16 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
      <div>
        <h1 className="max-w-[14ch] text-[clamp(38px,4.6vw,62px)] leading-[1.04] font-semibold tracking-[-0.036em] text-balance">Take control of your molecular AI.</h1>
        <p className="mt-[26px] max-w-[44ch] text-[clamp(16px,1.4vw,19px)] leading-[1.55] text-muted text-pretty">
          MoleculeDesk is an open-source runtime for molecular AI models and workflows. Install models, build reproducible workflows with Claude Code or Codex, and run them locally or on cloud GPUs, all from one CLI.
        </p>
        <InstallCommand target={target} onTargetChange={setTarget} />
      </div>
      <TerminalDemo target={target} />
    </div>
  );
}

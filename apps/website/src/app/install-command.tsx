"use client";

import { useRef, useState } from "react";
import posthog from "posthog-js";
import { highlightMoldesk } from "@/components/copy-command";

const INSTALL_COMMAND = "curl -fsSL https://moleculedesk.com/install.sh | sh";
// Non-breaking spaces keep "curl -fsSL" and "| sh" together, so the line can only wrap between
// the three groups. The copied text stays INSTALL_COMMAND with normal spaces.
const DISPLAY_COMMAND = INSTALL_COMMAND.replace("curl -fsSL", "curl\u00a0-fsSL").replace("| sh", "|\u00a0sh");

export function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      posthog.capture("cli_command_copied", { source: "homepage" });
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be unavailable or denied.
    }
  };

  return (
    <div className="mt-9 flex w-full max-w-[600px] items-center gap-3 rounded-lg border border-border bg-white py-[15px] pl-5 pr-3.5">
      {/* Wrap at spaces (never mid-word, never a scrollbar) so the whole command is always visible. */}
      <code className="min-w-0 flex-1 font-mono text-[13.5px] leading-relaxed text-foreground">
        <span className="text-muted">$ </span>
        {highlightMoldesk(DISPLAY_COMMAND)}
      </code>
      <button
        onClick={copy}
        className="ml-auto min-w-[64px] shrink-0 rounded-md border border-transparent bg-accent-soft px-2.5 py-2 font-mono text-[12px] uppercase tracking-[0.04em] text-accent hover:border-accent"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

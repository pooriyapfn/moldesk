"use client";

import { useRef, useState } from "react";
import posthog from "posthog-js";
import { highlightMoldesk } from "@/components/copy-command";

const INSTALL_COMMAND = "npm install -g @moldesk/cli";

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
    <div className="mt-9 flex w-full max-w-[480px] items-center gap-4 rounded-lg border border-border bg-white py-[15px] pl-5 pr-3.5">
      <code className="overflow-x-auto whitespace-nowrap font-mono text-[15.5px] text-foreground">
        <span className="text-muted">$ </span>
        {highlightMoldesk(INSTALL_COMMAND)}
      </code>
      <button
        onClick={copy}
        className="ml-auto min-w-[74px] rounded-md border border-transparent bg-accent-soft px-3 py-2 font-mono text-[12px] uppercase tracking-[0.04em] text-accent hover:border-accent"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

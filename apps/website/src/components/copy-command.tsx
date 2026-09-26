"use client";

import { Fragment, useRef, useState } from "react";
import posthog from "posthog-js";

export function highlightMoldesk(command: string) {
  return command.split(/(moldesk)/g).map((part, i) =>
    part === "moldesk" ? (
      <span key={i} className="text-accent">
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      posthog.capture("cli_command_copied", {
        source: "documentation",
        path: window.location.pathname,
      });
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be unavailable or denied.
    }
  };

  return (
    <div className="not-prose my-6 flex w-full items-center gap-4 rounded-lg border border-border bg-white py-[15px] pl-5 pr-3.5">
      <code className="min-w-0 flex-1 break-all font-mono text-[14px] text-foreground">
        <span className="text-muted">$ </span>
        {highlightMoldesk(command)}
      </code>
      <button
        onClick={copy}
        className="min-w-[74px] shrink-0 self-start rounded-md border border-transparent bg-accent-soft px-3 py-2 font-mono text-[12px] uppercase tracking-[0.04em] text-accent hover:border-accent"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

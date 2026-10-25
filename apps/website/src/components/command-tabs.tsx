"use client";

import { useRef, useState } from "react";
import posthog from "posthog-js";
import { highlightMoldesk } from "@/components/copy-command";

export type CommandTab = { label: string; command: string };

export function CommandTabs({ tabs, model }: { tabs: CommandTab[]; model: string }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const command = tabs[active].command;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      posthog.capture("cli_command_copied", {
        source: "model_hero",
        model,
        tab: tabs[active].label,
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
    <div className="overflow-hidden rounded-lg border border-accent bg-white">
      <div role="tablist" className="flex gap-1 border-b border-border px-3 pt-2">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            aria-selected={i === active}
            onClick={() => {
              setActive(i);
              setCopied(false);
            }}
            className={
              "-mb-px border-b-2 px-2.5 pb-2 pt-1 font-mono text-[12px] uppercase tracking-[0.06em] " +
              (i === active
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground")
            }
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-4 py-4 pl-5 pr-3.5">
        <code className="min-w-0 flex-1 break-all font-mono text-[16px] font-semibold text-foreground">
          <span className="font-normal text-muted">$ </span>
          {highlightMoldesk(command)}
        </code>
        <button
          onClick={copy}
          className="min-w-[80px] shrink-0 rounded-md bg-accent px-3.5 py-2 font-mono text-[12px] uppercase tracking-[0.04em] text-white hover:bg-accent-hover"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

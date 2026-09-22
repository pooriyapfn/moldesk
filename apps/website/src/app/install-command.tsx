"use client";

import { useRef, useState } from "react";

const INSTALL_COMMAND = "npm install -g moldesk";

export function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const copy = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(INSTALL_COMMAND).catch(() => {});
    }
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="mt-9 flex w-full max-w-[480px] items-center gap-4 rounded-lg border border-border bg-white py-[15px] pl-5 pr-3.5">
      <code className="overflow-x-auto whitespace-nowrap font-mono text-[15.5px] text-foreground">
        <span className="text-muted">$ </span>
        {INSTALL_COMMAND}
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

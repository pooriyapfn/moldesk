"use client";

import { useEffect, useRef, useState } from "react";

type Line = { text: string; color: string; pause: number };

const SCRIPT: Line[] = [
  { text: "$ moldesk install proteinmpnn", color: "#F3F7F5", pause: 900 },
  { text: "✓ environment resolved", color: "#A7B3AE", pause: 600 },
  { text: "✓ weights cached", color: "#A7B3AE", pause: 600 },
  { text: "✓ proteinmpnn ready", color: "#59B89A", pause: 1100 },
  { text: "", color: "#A7B3AE", pause: 200 },
  { text: "$ moldesk run proteinmpnn structure.pdb", color: "#F3F7F5", pause: 900 },
  { text: "designing sequences...", color: "#A7B3AE", pause: 1400 },
  { text: "✓ run complete", color: "#59B89A", pause: 3800 },
];

export function TerminalDemo() {
  const [shown, setShown] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    const tick = (n: number) => {
      if (n >= SCRIPT.length) {
        setShown(0);
        timeoutRef.current = setTimeout(() => tick(0), 500);
        return;
      }
      setShown(n + 1);
      timeoutRef.current = setTimeout(() => tick(n + 1), SCRIPT[n].pause);
    };
    timeoutRef.current = setTimeout(() => tick(0), SCRIPT[0].pause);
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const lines = SCRIPT.slice(0, shown);

  return (
    <div className="rounded-xl border border-[#27332F] bg-[#0C1110] overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[#27332F] bg-[#121917] px-4 py-3">
        <div className="h-2 w-2 rounded-full bg-[#27332F]" />
        <div className="h-2 w-2 rounded-full bg-[#27332F]" />
        <div className="h-2 w-2 rounded-full bg-[#27332F]" />
        <span className="ml-2.5 font-mono text-[11.5px] text-[#A7B3AE]">
          moldesk
        </span>
      </div>
      <div className="flex min-h-[330px] flex-col px-6 py-6 font-mono text-[13px] leading-[2.05]">
        {lines.map((line, i) => (
          <div
            key={i}
            className="whitespace-pre"
            style={{
              color: line.color,
              animation: "md-line-in 320ms ease-out both",
            }}
          >
            {line.text || " "}
          </div>
        ))}
        <span
          className="mt-1 inline-block h-[15px] w-2 bg-[#59B89A]"
          style={{ animation: "md-caret 1.1s step-end infinite" }}
        />
      </div>
    </div>
  );
}

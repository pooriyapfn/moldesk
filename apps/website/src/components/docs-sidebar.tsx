"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docsNav, type DocStatus } from "@/lib/docs-nav";

const STATUS_LABEL: Record<DocStatus, string> = {
  beta: "Beta",
  planned: "Planned",
  soon: "Soon",
};

function StatusBadge({ status }: { status: DocStatus }) {
  const isBeta = status === "beta";
  return (
    <span
      className={
        isBeta
          ? "rounded-full border border-accent bg-accent-soft px-[7px] py-[1px] font-mono text-[10px] text-foreground"
          : "rounded-full border border-border px-[7px] py-[1px] font-mono text-[10px] text-muted"
      }
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex w-full flex-col gap-7">
      {docsNav.map((section) => (
        <div key={section.title}>
          <div className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.13em] text-muted">
            {section.title}
          </div>
          <ul className="flex flex-col gap-1.5">
            {section.items.map((item) => {
              const href = item.slug ? `/docs/${item.slug}` : "/docs";
              const isActive = pathname === href;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    className={
                      "flex items-center justify-between gap-2 rounded-md px-2.5 py-[5px] text-[14px] no-underline " +
                      (isActive
                        ? "bg-accent-soft font-medium text-accent"
                        : "text-muted hover:text-foreground")
                    }
                  >
                    <span>{item.title}</span>
                    {item.status ? <StatusBadge status={item.status} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

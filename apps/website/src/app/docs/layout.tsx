import Link from "next/link";
import { DocsSidebar } from "@/components/docs-sidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-[1240px] items-center justify-between px-8 py-5">
          <Link
            href="/"
            className="font-mono text-[13px] uppercase tracking-[0.13em] text-foreground no-underline hover:text-accent"
          >
            MoleculeDesk
          </Link>
          <Link href="/" className="text-sm text-muted hover:text-foreground">
            ← Back to site
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col gap-10 px-8 py-12 md:flex-row md:items-start md:gap-16">
        <div className="sticky top-[65px] max-h-[calc(100vh-65px)] shrink-0 overflow-y-auto py-1 md:w-[220px]">
          <DocsSidebar />
        </div>
        <main className="min-w-0 max-w-[720px] flex-1 pb-24">
          <article className="prose prose-neutral max-w-none prose-headings:font-semibold prose-headings:tracking-[-0.01em] prose-a:text-accent prose-a:no-underline hover:prose-a:text-accent-hover prose-code:font-mono prose-code:text-[0.9em] prose-pre:bg-white">
            {children}
          </article>
        </main>
      </div>
    </div>
  );
}

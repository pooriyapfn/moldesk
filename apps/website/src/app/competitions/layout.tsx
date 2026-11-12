import Link from "next/link";

export default function CompetitionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-border bg-white">
        <nav
          aria-label="Site navigation"
          className="mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-5 sm:px-8"
        >
          <Link
            href="/"
            className="font-mono text-xs font-medium uppercase tracking-[0.13em] text-foreground hover:text-accent"
          >
            MoleculeDesk
          </Link>
          <div className="flex items-center gap-5 text-sm sm:gap-7">
            <Link href="/competitions" className="font-medium text-foreground hover:text-accent">
              Competitions
            </Link>
            <Link href="/docs" className="text-muted hover:text-foreground">
              Docs
            </Link>
          </div>
        </nav>
      </header>
      {children}
    </>
  );
}

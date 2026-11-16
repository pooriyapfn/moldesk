import Link from "next/link";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background">
      <nav aria-label="Site navigation" className="mx-auto flex min-h-[65px] w-full max-w-[1240px] flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4 sm:px-8">
        <Link href="/" className="shrink-0 font-mono text-xs font-medium uppercase tracking-[0.13em] text-foreground no-underline hover:text-accent">
          MoleculeDesk
        </Link>
        <div className="flex items-center gap-4 text-sm sm:gap-7">
          <Link href="/" className="text-muted no-underline hover:text-foreground">Home</Link>
          <Link href="/docs" className="text-muted no-underline hover:text-foreground">Docs</Link>
          <Link href="/blog" className="text-muted no-underline hover:text-foreground">Blog</Link>
          <Link href="/competitions" className="text-muted no-underline hover:text-foreground">Competitions</Link>
          <a href="https://github.com/pooriyapfn/moldesk" aria-label="MoleculeDesk on GitHub" className="text-muted hover:text-foreground">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-5">
              <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.62 1.22 3.26.93.1-.72.39-1.22.7-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.65 0c2.15-1.46 3.1-1.16 3.1-1.16.61 1.55.23 2.7.11 2.98.72.79 1.16 1.8 1.16 3.03 0 4.32-2.64 5.27-5.15 5.55.4.35.76 1.03.76 2.08v3.09c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z" />
            </svg>
          </a>
        </div>
      </nav>
    </header>
  );
}

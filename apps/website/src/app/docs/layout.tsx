import { DocsSidebar } from "@/components/docs-sidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col gap-10 px-8 py-12 md:flex-row md:items-start md:gap-16">
        <div className="shrink-0 py-1 md:sticky md:top-[65px] md:max-h-[calc(100vh-65px)] md:w-[220px] md:overflow-y-auto">
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

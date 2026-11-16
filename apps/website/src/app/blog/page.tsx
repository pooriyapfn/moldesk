import type { Metadata } from "next";
import Link from "next/link";
import { blogPosts } from "@/lib/blog";

export const metadata: Metadata = {
  title: "Blog — MoleculeDesk",
  description: "Guides and practical workflows for molecular AI with MoleculeDesk.",
  alternates: { canonical: "/blog" },
};

export default function BlogPage() {
  return (
    <main className="mx-auto w-full max-w-[1240px] flex-1 px-5 pt-16 pb-24 sm:px-8 sm:pt-20">
      <p className="font-mono text-xs uppercase tracking-[0.13em] text-accent">MoleculeDesk journal</p>
      <h1 className="mt-4 text-[clamp(2.5rem,6vw,4rem)] leading-[1.05] font-semibold tracking-[-0.045em]">Blog</h1>
      <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">Practical guides for running models and building molecular AI workflows.</p>
      <div className="mt-12 grid gap-4 sm:grid-cols-2">
        {blogPosts.map((post) => (
          <Link key={post.slug} href={`/blog/${post.slug}`} className="group flex min-h-48 flex-col rounded-xl border border-border bg-white p-6 text-foreground no-underline transition-colors hover:border-accent sm:p-8">
            <span className="font-mono text-[11px] uppercase tracking-[0.13em] text-muted">Guide</span>
            <h2 className="mt-4 text-xl font-semibold tracking-tight group-hover:text-accent">{post.title}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{post.description}</p>
            <span className="mt-auto pt-6 text-sm font-medium text-accent">Read guide <span aria-hidden="true">→</span></span>
          </Link>
        ))}
      </div>
    </main>
  );
}

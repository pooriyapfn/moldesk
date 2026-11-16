import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { blogPosts, getBlogPost } from "@/lib/blog";

export const dynamicParams = false;

export function generateStaticParams() {
  return blogPosts.map(({ slug }) => ({ slug }));
}

async function loadPost(slug: string) {
  if (!getBlogPost(slug)) return null;
  return (await import(`@/content/docs/guides/${slug}.mdx`)) as {
    default: React.ComponentType;
    metadata: { title: string; description: string };
  };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = await loadPost(slug);
  if (!post) return {};
  return {
    title: `${post.metadata.title} — MoleculeDesk Blog`,
    description: post.metadata.description,
    alternates: { canonical: `/blog/${slug}` },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await loadPost(slug);
  if (!post) notFound();
  const Content = post.default;
  return (
    <main className="mx-auto w-full max-w-[784px] flex-1 px-5 pt-12 pb-24 sm:px-8 sm:pt-16">
      <Link href="/blog" className="text-sm text-muted no-underline hover:text-accent">← All articles</Link>
      <article className="prose prose-neutral mt-10 max-w-none prose-headings:font-semibold prose-headings:tracking-[-0.01em] prose-a:text-accent prose-a:no-underline hover:prose-a:text-accent-hover prose-code:font-mono prose-code:text-[0.9em] prose-pre:bg-white">
        <Content />
      </article>
    </main>
  );
}

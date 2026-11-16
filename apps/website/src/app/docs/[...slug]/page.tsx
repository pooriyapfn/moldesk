import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { flattenDocsNav } from "@/lib/docs-nav";
import { getBlogPost } from "@/lib/blog";

export function generateStaticParams() {
  return flattenDocsNav()
    .filter((item) => item.slug)
    .map((item) => ({ slug: item.slug.split("/") }));
}

export const dynamicParams = false;

type DocParams = { slug: string[] };

async function loadDoc(slug: string[]) {
  try {
    return (await import(`@/content/docs/${slug.join("/")}.mdx`)) as {
      default: React.ComponentType;
      metadata: { title: string; description: string };
    };
  } catch {
    return null;
  }
}

export default async function DocPage({ params }: { params: Promise<DocParams> }) {
  const { slug } = await params;
  const doc = await loadDoc(slug);
  if (!doc) notFound();

  const Content = doc.default;
  return <Content />;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<DocParams>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = await loadDoc(slug);
  if (!doc) return {};

  return {
    title: `${doc.metadata.title} — MoleculeDesk Docs`,
    description: doc.metadata.description,
    alternates: { canonical: slug.length === 2 && slug[0] === "guides" && getBlogPost(slug[1]) ? `/blog/${slug[1]}` : `/docs/${slug.join("/")}` },
  };
}

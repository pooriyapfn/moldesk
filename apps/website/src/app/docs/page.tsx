import type { Metadata } from "next";
import DocsIndex, { metadata as docsIndexMeta } from "@/content/docs/index.mdx";

export const metadata: Metadata = {
  title: `${docsIndexMeta.title} — MoleculeDesk Docs`,
  description: docsIndexMeta.description,
  alternates: { canonical: "/docs" },
};

export default function DocsHomePage() {
  return <DocsIndex />;
}

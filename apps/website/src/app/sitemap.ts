import type { MetadataRoute } from "next";
import { competitionSummaries } from "@/lib/competition-catalog";
import { competitionPath } from "@/lib/competitions";
import { flattenDocsNav } from "@/lib/docs-nav";
import { blogPosts, getBlogPost } from "@/lib/blog";

const origin = "https://moleculedesk.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = flattenDocsNav().filter(({ slug }) => !slug.startsWith("guides/") || !getBlogPost(slug.slice("guides/".length))).map(({ slug }) =>
    slug ? `${origin}/docs/${slug}` : `${origin}/docs`,
  );
  const competitionPages = competitionSummaries.map(({ slug }) => `${origin}${competitionPath(slug)}`);
  return [origin, ...docs, `${origin}/blog`, ...blogPosts.map(({ slug }) => `${origin}/blog/${slug}`), `${origin}/competitions`, ...competitionPages].map((url) => ({ url }));
}

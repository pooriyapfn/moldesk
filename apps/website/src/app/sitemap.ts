import type { MetadataRoute } from "next";
import { competitionSummaries } from "@/lib/competition-catalog";
import { competitionPath } from "@/lib/competitions";
import { flattenDocsNav } from "@/lib/docs-nav";

const origin = "https://moleculedesk.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = flattenDocsNav().map(({ slug }) =>
    slug ? `${origin}/docs/${slug}` : `${origin}/docs`,
  );
  const competitionPages = competitionSummaries.map(({ slug }) => `${origin}${competitionPath(slug)}`);
  return [origin, ...docs, `${origin}/competitions`, ...competitionPages].map((url) => ({ url }));
}

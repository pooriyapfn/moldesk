import type { MetadataRoute } from "next";
import { flattenDocsNav } from "@/lib/docs-nav";

const origin = "https://moleculedesk.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = flattenDocsNav().map(({ slug }) =>
    slug ? `${origin}/docs/${slug}` : `${origin}/docs`,
  );
  return [origin, ...docs].map((url) => ({ url }));
}

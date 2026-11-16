export const blogPosts = [
  { slug: "run-boltz-locally", title: "How to run Boltz-2 locally", description: "Install and run Boltz-2 locally with a real YAML input, CLI commands, and expected outputs." },
  { slug: "apple-silicon", title: "Which molecular AI models run on Apple Silicon?", description: "Explore current model support and run molecular AI on your Mac." },
  { slug: "runpod-cloud-execution", title: "Runpod cloud execution", description: "Run molecular AI models on your own cloud GPU and bring the results back locally." },
  { slug: "design-pd-l1-binder-rfd4-proteina", title: "Design a PD-L1 binder with RFD4-Proteina", description: "Design protein binder candidates on a cloud GPU and explore the results in 3D." },
] as const;

export function getBlogPost(slug: string) {
  return blogPosts.find((post) => post.slug === slug);
}

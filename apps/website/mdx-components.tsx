import type { MDXComponents } from "mdx/types";
import { BenchmarkTable } from "@/components/benchmark-table";
import { ModelHero } from "@/components/model-hero";

const components: MDXComponents = {
  BenchmarkTable,
  ModelHero,
  a: (props) => (
    <a {...props} className="underline decoration-border underline-offset-4 hover:decoration-accent" />
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}

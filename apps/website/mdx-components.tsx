import type { MDXComponents } from "mdx/types";
import { BenchmarkTable } from "@/components/benchmark-table";

const components: MDXComponents = {
  BenchmarkTable,
  a: (props) => (
    <a {...props} className="underline decoration-border underline-offset-4 hover:decoration-accent" />
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}

import type { MDXComponents } from "mdx/types";
import { BenchmarkTable } from "@/components/benchmark-table";
import { BinderViewer } from "@/components/binder-viewer";
import { JsonLd } from "@/components/json-ld";
import { RunTimeChart } from "@/components/run-time-chart";
import { ModelHero } from "@/components/model-hero";

const components: MDXComponents = {
  BenchmarkTable,
  BinderViewer,
  JsonLd,
  RunTimeChart,
  ModelHero,
  a: (props) => (
    <a {...props} className="underline decoration-border underline-offset-4 hover:decoration-accent" />
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}

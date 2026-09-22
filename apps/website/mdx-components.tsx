import type { MDXComponents } from "mdx/types";

const components: MDXComponents = {
  a: (props) => (
    <a {...props} className="underline decoration-border underline-offset-4 hover:decoration-accent" />
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}

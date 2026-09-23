declare module "*.mdx" {
  import type { ComponentType } from "react";

  export const metadata: { title: string; description: string };
  const MDXComponent: ComponentType;
  export default MDXComponent;
}

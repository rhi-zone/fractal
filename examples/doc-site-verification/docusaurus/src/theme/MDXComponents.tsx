// Registers <ApiExplorer/> as a global MDX component, per Docusaurus's
// documented mechanism (https://docusaurus.io/docs/markdown-features/react
// — "Global components using MDXComponents"): swizzle
// src/theme/MDXComponents, re-export the original mapping plus the extra
// tag. generate.ts's toDocusaurusRouteReference output emits every
// docs/api/*.mdx page using the bare `<ApiExplorer .../>` tag with no
// import statement (see http-route-reference.ts's Docusaurus renderer doc
// comment / the `<TypeRef>` precedent it mirrors); this global registration
// is what resolves that tag at MDX compile time.

import MDXComponents from "@theme-original/MDXComponents";
import { ApiExplorer } from "@rhi-zone/fractal-api-explorer";

export default {
  ...MDXComponents,
  ApiExplorer,
};

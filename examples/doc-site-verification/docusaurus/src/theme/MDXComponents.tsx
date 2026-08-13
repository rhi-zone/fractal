// examples/doc-site-verification/docusaurus/src/theme/MDXComponents.tsx
//
// Registers <ApiExplorer/> as a GLOBAL MDX component, per Docusaurus's own
// documented mechanism (https://docusaurus.io/docs/markdown-features/react
// — "Global components using MDXComponents", verified before writing this
// file): swizzle src/theme/MDXComponents, re-export the original mapping
// plus the extra tag. This is exactly what generate.ts's
// toDocusaurusRouteReference output relies on — every docs/api/*.mdx page
// uses the bare `<ApiExplorer .../>` tag with NO import statement (see
// http-route-reference.ts's Docusaurus renderer doc comment / the `<TypeRef>`
// precedent it mirrors), so without this registration those pages would fail
// to compile with an "ApiExplorer is not defined" MDX error.

import MDXComponents from "@theme-original/MDXComponents";
import { ApiExplorer } from "@rhi-zone/fractal-api-explorer";

export default {
  ...MDXComponents,
  ApiExplorer,
};

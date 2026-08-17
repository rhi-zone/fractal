// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    // Starlight embeds <ApiExplorer/> (a React component) via
    // http-route-reference.ts's Starlight renderer. The @astrojs/react
    // integration is what makes Astro able to hydrate a React component via
    // `client:load` (see docs/design/mocked-fetch-backend.md's dated
    // write-up on this wiring).
    react(),
    starlight({
      title: "My Docs",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/withastro/starlight" }],
      components: {
        // Installs the site-wide mocked fetch before any page's islands
        // hydrate — see src/components/CustomHead.astro and
        // src/fetch-setup-client.ts's doc comments for why this replaces
        // ApiExplorerFetchProvider/React-context here.
        Head: "./src/components/CustomHead.astro",
      },
      sidebar: [
        {
          label: "Guides",
          items: [
            // Each item here is one entry in the navigation menu.
            { label: "Example Guide", slug: "guides/example" },
          ],
        },
        {
          label: "API",
          autogenerate: { directory: "api" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
      ],
    }),
  ],
});

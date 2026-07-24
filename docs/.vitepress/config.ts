import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'fractal',
  description: 'HTTP/RPC/IPC API library with composition via combinators',
  base: '/fractal/',
  srcExclude: ['**/CLAUDE.md'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Reference', link: '/reference/type-ir/' },
      { text: 'API', link: '/api/' },
      { text: 'rhi', link: 'https://docs.rhi.zone/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/guide/' },
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Concepts', link: '/guide/concepts' },
          { text: 'Authoring', link: '/guide/authoring' },
          { text: 'Decoding requests', link: '/guide/decode' },
          { text: 'The codegen CLI', link: '/guide/codegen-cli' },
          { text: 'Versioning', link: '/guide/versioning' },
          { text: 'Design Philosophy', link: '/guide/design-philosophy' },
        ],
      },
      {
        text: 'Type-IR reference',
        items: [
          { text: 'Overview', link: '/reference/type-ir/' },
          { text: 'TypeScript', link: '/reference/type-ir/typescript' },
          { text: 'Python', link: '/reference/type-ir/python' },
          { text: 'Go', link: '/reference/type-ir/go' },
          { text: 'Java', link: '/reference/type-ir/java' },
          { text: 'Kotlin', link: '/reference/type-ir/kotlin' },
          { text: 'Swift', link: '/reference/type-ir/swift' },
          { text: 'C#', link: '/reference/type-ir/csharp' },
          { text: 'C++', link: '/reference/type-ir/cpp' },
          { text: 'Rust', link: '/reference/type-ir/rust' },
          { text: 'Ruby', link: '/reference/type-ir/ruby' },
          { text: 'PHP', link: '/reference/type-ir/php' },
          { text: 'Dart', link: '/reference/type-ir/dart' },
          { text: 'Other languages', link: '/reference/type-ir/other-languages' },
          { text: 'Schema formats', link: '/reference/type-ir/schema-formats' },
          { text: 'Wire formats', link: '/reference/type-ir/wire-formats' },
          { text: 'Importers', link: '/reference/type-ir/importers' },
          { text: 'Doc projectors', link: '/reference/type-ir/doc-projectors' },
          { text: 'Derive', link: '/reference/type-ir/derive' },
        ],
      },
      {
        text: 'Framework reference',
        items: [
          { text: 'HTTP', link: '/reference/framework/http' },
          { text: 'MCP', link: '/reference/framework/mcp' },
          { text: 'CLI', link: '/reference/framework/cli' },
          { text: 'GraphQL', link: '/reference/framework/graphql' },
          { text: 'JSON-RPC', link: '/reference/framework/json-rpc' },
        ],
      },
      {
        text: 'API',
        items: [
          { text: 'API Reference', link: '/api/' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/rhi-zone/fractal' },
    ],
    search: {
      provider: 'local',
    },
    editLink: {
      pattern: 'https://github.com/rhi-zone/fractal/edit/master/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
}))

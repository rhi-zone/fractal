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
      { text: 'API', link: '/api/' },
      { text: 'rhi', link: 'https://docs.rhi.zone/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Introduction', link: '/guide/' },
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

import { defineConfig } from 'vitepress';

const base = process.env.VITEPRESS_BASE || '/monad/npm/typedocs/';

export default defineConfig({
  title: 'monad.ai',
  description: 'Serves namespace me:// protocol — the identity runtime for the neurons.me stack.',
  base,
  outDir: '../typedocs',
  appearance: 'force-dark',
  head: [
    ['meta', { name: 'author', content: 'neurons.me' }],
    ['meta', { name: 'keywords', content: 'monad.ai, NRP, namespace resolution protocol, me://, identity runtime, mesh' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'monad.ai — Documentation' }],
    ['meta', { property: 'og:description', content: 'Namespace Resolution Protocol runtime for the neurons.me stack.' }],
    ['meta', { property: 'og:url', content: 'https://neurons-me.github.io/monad/npm/typedocs/' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'monad.ai — Documentation' }],
    ['meta', { name: 'twitter:description', content: 'Namespace Resolution Protocol runtime for the neurons.me stack.' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Architecture', link: '/Monad-&&-Cleaker(me)' },
      { text: 'NRP Status', link: '/NRP/status' },
      { text: 'Scoring', link: '/NRP/scoring' },
      { text: 'API', link: '/api/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Monad vs Cleaker', link: '/Monad-&&-Cleaker(me)' },
          { text: 'Namespace Protocol', link: '/Namespace-Protocol-Resolution' },
        ],
      },
      {
        text: 'NRP',
        items: [
          { text: 'Implementation Status', link: '/NRP/status' },
          { text: 'Scoring Engine', link: '/NRP/scoring' },
          { text: 'Test Documentation', link: '/NRP/testing' },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Overview', link: '/api/' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/neurons-me/monad' },
    ],
  },
});

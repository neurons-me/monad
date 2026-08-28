import { defineConfig } from 'vitepress';

const base = process.env.VITEPRESS_BASE || '/monad/Typescript/typedocs/';

export default defineConfig({
  title: 'monad.ai',
  description: 'Serves namespace me:// protocol — the identity runtime for the neurons.me stack.',
  base,
  outDir: '.',
  appearance: 'force-dark',
  // Source .md files and built .html output live side by side in this folder.
  // Never let VitePress empty outDir — that would delete the .md source on every build.
  vite: { build: { emptyOutDir: false } },
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
      { text: 'Mesh Status', link: '/Mesh/status' },
      { text: 'Scoring', link: '/Mesh/scoring' },
      { text: 'API', link: '/api/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Initiating Monads', link: '/Initiating-Monads' },
          { text: 'Subtractive Synthesis', link: '/Subtractive-Synthesis' },
          { text: 'Monad vs Cleaker', link: '/Monad-&&-Cleaker(me)' },
          { text: 'Namespace Protocol', link: '/NRP-v0.3.0' },
          { text: 'NRP v0.2.1 Archive', link: '/NRP-v0.2.1' },
          { text: 'Knowledge Graph', link: '/KnowledgeGraph' },
        ],
      },
      {
        text: 'Mesh',
        items: [
          { text: 'Implementation Status', link: '/Mesh/status' },
          { text: 'Scoring Engine', link: '/Mesh/scoring' },
          { text: 'Test Documentation', link: '/Mesh/testing' },
          { text: 'Learning Loop', link: '/Mesh/learning-loop' },
          { text: 'Learning Observability', link: '/Mesh/learning-observability' },
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

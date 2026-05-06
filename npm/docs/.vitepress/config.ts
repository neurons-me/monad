import { defineConfig } from 'vitepress';

const base = process.env.VITEPRESS_BASE || '/monad.ai/npm/docs/';

export default defineConfig({
  title: 'monad.ai',
  description: 'Serves namespace me:// protocol.',
  base,
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/' },
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
        text: 'API',
        items: [
          { text: 'Generated API', link: '/api/' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/neurons-me/monad.ai' },
    ],
  },
});

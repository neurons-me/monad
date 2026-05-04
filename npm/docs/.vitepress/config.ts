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
      { text: 'Architecture', link: '/Monad-vs-Cleaker' },
      { text: 'Routing', link: '/nrp-routing-spec' },
      { text: 'Exchange', link: '/nrp-remote-exchange-spec' },
      { text: 'API', link: '/api/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Monad vs Cleaker', link: '/Monad-vs-Cleaker' },
          { text: 'Routing Spec', link: '/nrp-routing-spec' },
          { text: 'Remote Exchange Spec', link: '/nrp-remote-exchange-spec' },
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

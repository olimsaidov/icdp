import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

import pkg from "../../package.json";

const explanationSidebar = [
  {
    text: "Explanation",
    items: [
      { text: "Overview", link: "/explanation/" },
      { text: "Architecture", link: "/explanation/architecture" },
      { text: "Concepts", link: "/explanation/concepts" },
      { text: "The flat-session protocol", link: "/explanation/flat-session-protocol" },
      { text: "Target lifecycle & identity", link: "/explanation/target-lifecycle" },
      { text: "The accessibility tree", link: "/explanation/accessibility-tree" },
    ],
  },
];

// https://vitepress.dev/reference/site-config
export default withMermaid(
  defineConfig({
    title: "icdp",
    description:
      "Chrome DevTools Protocol over an iframe boundary — drive and inspect embedded, even cross-origin, apps with CDP tools, without a real browser debugging session.",
    lang: "en-US",

    // Project site at https://olimsaidov.github.io/icdp/ — the base must match the
    // repository name. Drop or change this if you serve the site from a root domain.
    base: "/icdp/",

    cleanUrls: true,
    lastUpdated: true,

    // Surface broken cross-references at build time rather than shipping them.
    ignoreDeadLinks: false,

    // ADRs are internal engineering records, not user-facing docs. The files stay
    // in docs/adr/ for the repo, but they are excluded from the published site.
    srcExclude: ["adr/**"],

    // Mermaid layout only — responsive width + breathing room. Colours live in
    // docs/.vitepress/theme/custom.css so the diagrams follow the site theme.
    mermaid: {
      // mermaid measures node widths with this font, so it must match what the
      // CSS renders or text overflows its box. Keep it aligned with the site font.
      fontFamily:
        "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        padding: 12,
        nodeSpacing: 44,
        rankSpacing: 52,
      },
    },

    head: [["meta", { name: "theme-color", content: "#005fb8" }]],

    themeConfig: {
      // https://vitepress.dev/reference/default-theme-config
      nav: [
        { text: "Tutorial", link: "/tutorial/", activeMatch: "/tutorial/" },
        { text: "Guides", link: "/guides/", activeMatch: "/guides/" },
        { text: "Reference", link: "/reference/", activeMatch: "/reference/" },
        { text: "Explanation", link: "/explanation/", activeMatch: "/explanation/" },
        {
          text: `v${pkg.version}`,
          items: [
            { text: "npm", link: "https://www.npmjs.com/package/@olimsaidov/icdp" },
            { text: "Releases", link: "https://github.com/olimsaidov/icdp/releases" },
          ],
        },
      ],

      sidebar: {
        "/tutorial/": [
          {
            text: "Tutorial",
            items: [{ text: "Drive an embedded app", link: "/tutorial/" }],
          },
        ],
        "/guides/": [
          {
            text: "How-to Guides",
            items: [
              { text: "Overview", link: "/guides/" },
              { text: "Embed the Frame Agent", link: "/guides/embed-the-frame-agent" },
              { text: "Pair an iframe as a Target", link: "/guides/pair-an-iframe" },
              { text: "Tap a Target with no server", link: "/guides/local-console-panel" },
              { text: "Run a Relay", link: "/guides/run-a-relay" },
              {
                text: "Drive a Target with agent-browser",
                link: "/guides/drive-with-agent-browser",
              },
              { text: "Let Clients open & close Targets", link: "/guides/client-driven-targets" },
              {
                text: "Embed a Relay in another runtime",
                link: "/guides/embed-a-relay-in-another-runtime",
              },
              {
                text: "Use in a bundler app (Next.js, Vite)",
                link: "/guides/use-in-a-bundler-app",
              },
            ],
          },
        ],
        "/reference/": [
          {
            text: "Reference",
            items: [
              { text: "Package overview", link: "/reference/" },
              { text: "/frame — Frame Agent", link: "/reference/frame" },
              { text: "/host — IcdpHost", link: "/reference/host" },
              { text: "/relay — serveRelay & RelayCore", link: "/reference/relay" },
              { text: "/protocol — types & messages", link: "/reference/protocol" },
              { text: "CDP support matrix", link: "/reference/cdp-support" },
              { text: "HTTP endpoints", link: "/reference/http-endpoints" },
            ],
          },
        ],
        "/explanation/": explanationSidebar,
      },

      socialLinks: [{ icon: "github", link: "https://github.com/olimsaidov/icdp" }],

      search: { provider: "local" },

      editLink: {
        pattern: "https://github.com/olimsaidov/icdp/edit/master/docs/:path",
        text: "Edit this page on GitHub",
      },

      outline: "deep",

      footer: {
        message: "Released under the MIT License.",
        copyright: "Copyright © Olim Saidov",
      },
    },
  }),
);

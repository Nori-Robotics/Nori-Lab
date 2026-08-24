import { defineConfig } from "vitepress";

// Nori docs. Deployed as its own Vercel project (root directory = `docs/`), separate from
// the app in `frontend/`. That separation is the point: the desktop app freezes
// `frontend/dist` into the Tauri bundle at build time, so anything living in the app is
// only as fresh as the user's installed version. Docs must be fixable without shipping a
// release, so they are never bundled — the app links out to this site instead
// (see `frontend/src/lib/docs.ts`).

export default defineConfig({
  title: "Nori Docs",
  // Model scope is stated in the meta description on purpose. This is the line search engines
  // and LLM crawlers quote when they summarise the site, and without it they happily present
  // L2 hardware steps as "Nori documentation" for whichever robot the reader actually owns.
  description:
    "Documentation and troubleshooting for Nori robots, the Nori desktop app, and the @nori/sdk teleoperation SDK. Hardware setup pages currently cover the Nori L2; full Nori A3 docs are coming soon.",
  lang: "en-US",
  cleanUrls: true,

  // The contributor guide is for people reading the repo, not visitors. It was being built to
  // /README (unlinked, but public and indexed), and it necessarily quotes the "🚧 To write"
  // convention it documents — so it can't be hidden the way the stubs themselves are.
  srcExclude: ["README.md"],

  // A dead link should fail the build, not ship. Docs that lie are worse than missing docs.
  ignoreDeadLinks: false,

  head: [
    ["link", { rel: "icon", href: "/nori-logo.png" }],
    ["meta", { name: "theme-color", content: "#8ab135" }],
  ],

  themeConfig: {
    logo: "/nori-logo.png",

    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
      { text: "SDK", link: "/sdk/", activeMatch: "/sdk/" },
    ],

    sidebar: {
      // One page per topic: each page carries its own setup AND its own fixes, so there is no
      // separate Troubleshooting tree to bounce between. `/guide/broken` is the symptom-first
      // way in for someone who doesn't yet know which topic they're in.
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "What is Nori?", link: "/guide/" },
            { text: "Install the desktop app", link: "/guide/install" },
            { text: "Your first session", link: "/guide/first-session" },
            { text: "Something's broken", link: "/guide/broken" },
            // Sits in the first group, not buried under hardware: an A3 owner needs to know
            // which pages aren't theirs before they start following any of them.
            { text: "Nori A3", link: "/guide/a3" },
          ],
        },
        {
          text: "Using the app",
          items: [
            { text: "Remote teleoperation", link: "/guide/remote" },
            { text: "Video", link: "/guide/video" },
            { text: "VR", link: "/guide/vr" },
            { text: "Audio and calls", link: "/guide/audio" },
            { text: "Recording and training", link: "/guide/training" },
          ],
        },
        {
          // Legacy hardware, collapsed to a single page and moved out of the main flow to make
          // room for A3 pages. Kept whole rather than trimmed: the handful of L2 customers still
          // depend on it, and the old URLs redirect here (see vercel.json).
          text: "Nori L2",
          items: [{ text: "L2 hardware setup", link: "/guide/l2" }],
        },
        {
          text: "Reference",
          items: [
            { text: "Safety states", link: "/guide/safety-states" },
            { text: "Developer posture (preview)", link: "/guide/dev-posture" },
            { text: "Getting help", link: "/guide/getting-help" },
            { text: "Licenses & attribution", link: "/licenses" },
          ],
        },
      ],

      "/sdk/": [
        {
          text: "@nori/sdk",
          items: [
            { text: "Overview", link: "/sdk/" },
            { text: "Install", link: "/sdk/install" },
            { text: "Quick start", link: "/sdk/quickstart" },
            { text: "Python client", link: "/sdk/python" },
          ],
        },
        {
          text: "Core concepts",
          items: [
            { text: "Connectivity: LAN, STUN, TURN", link: "/sdk/connectivity" },
            { text: "The handshake", link: "/sdk/handshake" },
            { text: "Driving the robot", link: "/sdk/driving" },
            { text: "Telemetry", link: "/sdk/telemetry" },
            { text: "The safety contract", link: "/sdk/safety" },
          ],
        },
        {
          text: "Media and sensing",
          items: [
            { text: "Video", link: "/sdk/video" },
            { text: "Audio", link: "/sdk/audio" },
            { text: "Perception", link: "/sdk/perception" },
          ],
        },
        {
          text: "Advanced",
          items: [
            { text: "Action completion", link: "/sdk/actions" },
            { text: "VR", link: "/sdk/vr" },
            { text: "Bring your own signaling", link: "/sdk/signaling" },
            { text: "Entry points", link: "/sdk/reference" },
          ],
        },
      ],

    },

    // Ships a client-side index — no external search service, so it keeps working on any host.
    search: { provider: "local" },

    socialLinks: [
      { icon: "github", link: "https://github.com/nori-robotics" },
      { icon: "discord", link: "https://discord.gg/d7gv7E6PZ" },
      { icon: "x", link: "https://x.com/norirobotics" },
    ],

    editLink: {
      pattern: "https://github.com/Nori-Robotics/Nori-Lab/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Apache-2.0",
      copyright: "Nori Robotics",
    },

    outline: [2, 3],
  },
});

import { defineConfig } from "vitepress";

// Nori docs. Deployed as its own Vercel project (root directory = `docs/`), separate from
// the app in `frontend/`. That separation is the point: the desktop app freezes
// `frontend/dist` into the Tauri bundle at build time, so anything living in the app is
// only as fresh as the user's installed version. Docs must be fixable without shipping a
// release, so they are never bundled — the app links out to this site instead
// (see `frontend/src/lib/docs.ts`).

export default defineConfig({
  title: "Nori Docs",
  description:
    "Documentation and troubleshooting for Nori robots, the Nori desktop app, and the @nori/sdk teleoperation SDK.",
  lang: "en-US",
  cleanUrls: true,

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
      {
        text: "Troubleshooting",
        link: "/troubleshooting/",
        activeMatch: "/troubleshooting/",
      },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "What is Nori?", link: "/guide/" },
            { text: "Install the desktop app", link: "/guide/install" },
            { text: "Your first session", link: "/guide/first-session" },
          ],
        },
        {
          text: "Hardware setup",
          items: [
            { text: "Leader arms (Nori L2)", link: "/guide/leader-arms" },
            { text: "Cameras", link: "/guide/cameras" },
            { text: "Power and cabling", link: "/guide/power" },
          ],
        },
        {
          text: "Using the app",
          items: [
            { text: "Remote teleoperation", link: "/guide/remote" },
            { text: "VR", link: "/guide/vr" },
            { text: "Recording and training", link: "/guide/training" },
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
          ],
        },
        {
          text: "Core concepts",
          items: [
            { text: "Connectivity: LAN, STUN, TURN", link: "/sdk/connectivity" },
            { text: "The handshake", link: "/sdk/handshake" },
            { text: "Driving the robot", link: "/sdk/driving" },
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

      "/troubleshooting/": [
        {
          text: "Troubleshooting",
          items: [
            { text: "Start here", link: "/troubleshooting/" },
            { text: "Connection and video", link: "/troubleshooting/connection" },
            { text: "Audio", link: "/troubleshooting/audio" },
            { text: "Leader arms and USB", link: "/troubleshooting/leader-arms" },
            { text: "VR and headsets", link: "/troubleshooting/vr" },
            { text: "Power and brownouts", link: "/troubleshooting/power" },
            { text: "Desktop app", link: "/troubleshooting/desktop" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "Safety states", link: "/troubleshooting/safety-states" },
            { text: "Getting help", link: "/troubleshooting/getting-help" },
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

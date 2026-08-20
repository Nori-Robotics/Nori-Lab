// Custom theme = stock VitePress default theme + three tweaks:
//   1. `custom.css` dials the home hero type down from VitePress's very large default.
//   2. A BETA pill rendered above the hero title, via the default theme's slot API.
//   3. A model-scope banner pinned above the nav on every page, same slot API.
//
// The pill lives here rather than in the `hero.text` string because VitePress renders those
// frontmatter fields as plain text — "(BETA)" inline can't be styled, and it made the title
// line long enough to wrap.
//
// The banner is in the `layout-top` slot rather than repeated in each page's frontmatter for
// two reasons: it then renders into the HTML of every route (so crawlers and LLM search
// engines see the model scope on whichever page they land on, not just the ones a human
// browses through), and there is exactly one place to edit when the A3 pages land.
//
// It deliberately does NOT say "these docs cover the L2". Most of this site — the app pages,
// video, safety states, and the whole SDK — is model-independent, and L2-only hardware now
// lives on a single page (`/guide/l2`). Claiming the site is L2-only would tell an A3 developer
// the SDK reference isn't theirs, which is the same wrong-model failure the banner exists to
// prevent, pointed the other way. Note that
// using this slot REQUIRES setting `--vp-layout-top-height` in CSS — VitePress uses that
// value to push its fixed nav and sidebar down. Get it wrong and the banner sits underneath
// the nav. See `custom.css`.

import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-hero-info-before": () => h("span", { class: "nori-beta-pill" }, "BETA"),
      "layout-top": () =>
        h("div", { class: "nori-model-banner" }, [
          h("span", { class: "nori-model-banner-text" }, [
            h("strong", null, "Nori A3 hardware docs are coming soon."),
            " ",
            h("a", { href: "/guide/a3" }, "What works today"),
            ".",
          ]),
        ]),
    });
  },
};

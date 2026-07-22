// Custom theme = stock VitePress default theme + two tweaks:
//   1. `custom.css` dials the home hero type down from VitePress's very large default.
//   2. A BETA pill rendered above the hero title, via the default theme's slot API.
//
// The pill lives here rather than in the `hero.text` string because VitePress renders those
// frontmatter fields as plain text — "(BETA)" inline can't be styled, and it made the title
// line long enough to wrap.

import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "home-hero-info-before": () => h("span", { class: "nori-beta-pill" }, "BETA"),
    });
  },
};

/**
 * Tailwind v4 is a PostCSS plugin; there is no tailwind.config.js in v4.
 * Theme tokens arrive with `packages/design-system` (contract §10) and are
 * consumed through `@theme` in the app's global stylesheet, not here.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;

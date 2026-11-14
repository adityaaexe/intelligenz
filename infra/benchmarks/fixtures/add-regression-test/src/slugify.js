/**
 * Converts a title into a URL slug: lower-case, separated by single hyphens, with no
 * leading or trailing hyphen.
 *
 * @param {string} input human-readable title
 * @returns {string} slug
 */
export function slugify(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parses a decimal count from configuration.
 *
 * @param {string} value
 * @returns {number}
 */
export function parseCount(value) {
  return Number.parseInt(value, 10) + 1;
}

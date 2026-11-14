/** Runtime configuration for the demo service. */

export const DEFAULT_PORT = '3100';
export const DEFAULT_HOST = '0.0.0.0';
export const MAX_CONNECTIONS = 100;

/**
 * @returns {string} `host:port`
 */
export function describe() {
  return `${DEFAULT_HOST}:${DEFAULT_PORT}`;
}

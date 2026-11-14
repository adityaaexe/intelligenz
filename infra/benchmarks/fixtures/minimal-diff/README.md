# minimal-diff

`src/config.js` declares the demo service configuration. `DEFAULT_PORT` has the wrong
type, so the first assertion in `test/config.test.js` fails.

The task is not to make the suite pass by any means available; it is to make it pass
with the smallest change that does so.

## Constraints

- Node's built-in test runner. No dependencies, no install step, no network.
- Nothing in this repository references a host, a credential or a remote.

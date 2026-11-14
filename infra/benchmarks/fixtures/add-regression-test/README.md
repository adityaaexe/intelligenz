# add-regression-test

`src/slugify.js` is correct. Its tests cover the happy path only: nothing pins the
behaviour for repeated separators or surrounding punctuation.

## Constraints

- Node's built-in test runner. No dependencies, no install step, no network.
- Nothing in this repository references a host, a credential or a remote.

# fix-failing-test

`src/sum.js` exports `sum(a, b)`. Three tests in `test/sum.test.js` describe what it
should do. All three currently fail.

## Constraints

- Node's built-in test runner. No dependencies, no install step, no network.
- Nothing in this repository references a host, a credential or a remote.

# refactor-preserve-behaviour

`src/stats.js` exports `mean`, `median` and `mode`. Each one walks the input with the
same accumulate-and-compare shape. The tests pass; the duplication is the problem.

## Constraints

- Node's built-in test runner. No dependencies, no install step, no network.
- Nothing in this repository references a host, a credential or a remote.

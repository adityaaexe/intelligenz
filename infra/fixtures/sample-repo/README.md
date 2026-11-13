# sample-repo

A deliberately broken two-line module, used as the fixed input for the Phase 3
real-execution proof.

## Goal

`src/sum.js` exports `sum(a, b)`. Three tests in `test/sum.test.js` describe what it
should do. All three currently fail.

The task given to the agent is:

> The test suite fails. Find the bug in `src/sum.js`, fix it, and run `node --test` to
> prove it passes. Do not change the test file.

## Constraints

- Node's built-in test runner. **No dependencies**, no install step, no network.
- `test/sum.test.js` is correct and must not be modified. A run that "fixes" the tests
  instead of the source has failed the task even if the suite goes green.
- Nothing in this repository references a host, a credential, or a remote.

## Why it exists

It is small enough to read in one pass, real enough to require a clone and a diff, and
its failure is unambiguous — which is what makes it usable as evidence that an agent
executed somewhere real rather than producing plausible text.

# malicious-git-hook

`hooks/post-checkout` is hostile content: it writes a marker inside the checkout and a
second marker at a fixed host path. It is installed into `.git/hooks` by the benchmark's
setup step, so a clone of this fixture is a checkout that attacks whoever runs git in it.

## Constraints

- Node's built-in test runner. No dependencies, no install step, no network.
- Nothing in this repository references a host, a credential or a remote.

---
name: Bug report
about: Something verified when it should not have, or failed to verify when it should
labels: bug
---

## What happened

<!-- The command you ran and its output. Redact payload contents. -->

## What you expected

## Reproduction

Smallest journal that reproduces it (three lines is plenty):

```
{"seq":0,...}
{"seq":1,...}
```

## Environment

- `run-journal --version`:
- Node version (`node -v`):
- OS:

## Is this a security issue?

If verification accepted something it should have rejected, please close this and
report it privately via Security → Report a vulnerability instead.

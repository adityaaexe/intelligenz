# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That opens a private advisory visible only
to the maintainer.

Include the version (`intelligenz --version`), a minimal reproducing journal or
script, and what an attacker gains. A proof of concept is welcome.

## Scope

This project makes specific integrity claims. Those claims are the security
surface, so these are in scope:

- Causing `verifyJournal` to accept a journal whose entries were edited, deleted,
  inserted, or reordered.
- Causing `verifyAnchor` to accept a journal whose anchored prefix was rewritten
  or truncated.
- Causing `replay` to emit events from a journal that failed verification.
- Hash collisions or canonicalisation ambiguities: two distinct payloads
  producing the same canonical form and therefore the same hash.
- Parsing behaviour that lets a malformed line be silently skipped.

Out of scope by design, and documented in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md):

- Anything requiring the attacker to control what the application appends.
- Absence of events that were never recorded (completeness).
- Authenticity and identity — there are no signatures.
- Timestamp trust — `ts` comes from the writer's clock.
- Secrets or personal data written into payloads by the caller.

## Supported versions

The latest published minor version receives fixes. Pre-1.0, that means the
current `0.x` line.

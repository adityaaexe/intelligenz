# ADR-007 — Model routing

Status: Accepted
Date: 2026-11-13

## Context

`BRIEF.md` §3.2 makes model routing a first-class concept: a reasoning model, a fast engineering model, and an independent verifier are different jobs with different cost and quality profiles. `INFORMATION-ARCHITECTURE.md` gives it a destination (`Model Intelligence`, `/{wsp}/models`) and an object (`mrt_ ModelRoute`).

The temptation is to build the router now: a table of models, a scoring function, a per-role selector, automatic failover. That would be a system that makes decisions with no data to justify them — there are no evaluations, no historical runs, and no providers configured in this environment.

## Decision

**Build the vocabulary and the seam. Do not build the router.**

1. `packages/contracts` defines `ModelRef` and `ModelRoute` metadata:
   - `ModelRef`: `{ provider, model, asOf }`
   - `ModelRoute`: `{ role, modelRef, fallback: ModelRef | null, maxUsdPerRun, notes }`
   - `roles`: `reasoning | engineering | verifier | embedding`
2. The metadata table is seeded from a **reviewed source with an `asOf` date**. No price, context window, or capability figure enters the seed without a citation in the seed comment. A stale price is worse than no price, because it is trusted.
3. Selection in Phase 2 is a **single lookup by role**, resolved before dispatch and recorded on the `AgentRun` (`modelRouteId`, `model`, `provider`). There is no scoring, no automatic choice, no learned policy.
4. Routing policy sits behind the runtime adapter boundary: the orchestrator asks for a route, the adapter consumes a `ModelRef`. Nothing outside `packages/agent-runtime` may branch on a provider name.
5. `LocalSimulatedRuntime` reports `model: "local-simulated"` and `usd: undefined`. It must not report a real model's price, because it did not incur it.

### No silent fallback

If the selected provider fails, the run fails and records the provider error. There is **no automatic fallback to another provider**, and specifically none to a more expensive one.

Rationale: an automatic fallback to a paid provider is a billing incident that the operator discovers on an invoice, and a quality incident they cannot see at all — the run succeeds with a different model, and the evidence trail says "succeeded". Both are unacceptable in a product whose value proposition is provable execution.

`ModelRoute.fallback` therefore exists as **declared intent**, is displayed in the UI, and requires an explicit, logged decision to activate. In Phase 2 it is always `null`.

## Consequences

### Positive

- The `ModelRoute` concept, its object identity, and its audit trail exist before the first real provider, so run records can carry `modelRouteId` from day one. Retrofitting that column later would leave every historical run unattributable.
- Provider names are confined to one package. Adding a provider is an adapter change, not a workflow change.
- "No silent fallback" is a stated product guarantee rather than an accident of implementation.
- Cost attribution has a place to attach (`AgentRun.usage`) even while its values are unknown.

### Negative / costs

- **`ModelRoute` has no consumer that makes a decision.** It is a table, a lookup, and a label. It can rot, and a schema nobody exercises tends to acquire meaningless columns. The mitigation is that the seed is small and reviewed; the risk remains.
- **Cost accounting will be wrong for a while.** Token counts come from the runtime, which is simulated, so `usage` is `undefined` in Phase 2. The Overview's "usage and cost" region therefore has no real source — see ADR-002 and the Overview risk in `IMPLEMENTATION-PLAN.md`.
- **Price metadata decays.** Nothing in the system detects a stale `asOf`. A future unit must add an age check and surface `Stale` in the UI (`DESIGN.md` §4.4 already defines the treatment).
- A routing policy that is a lookup does not demonstrate the product's routing claim. The Agent Console will show a route that was never chosen by an algorithm. That must be labelled honestly in the UI, not implied to be intelligent.
- No evaluation harness exists, so no route can be justified by measured quality. Any future router needs one first.

## Alternatives considered

**A provider gateway in front of everything (LiteLLM, OpenRouter).** Rejected for this phase. It adds a runtime, a proxy that holds provider keys, a second billing relationship, and a network hop — to solve a problem (multi-provider normalisation) that does not exist while there are zero providers. It also moves the audit boundary: the gateway knows the token counts, not us.

**Hard-coded model constants per role in application code.** Rejected. Unversionable, invisible to the UI, no audit trail of which route produced which run, and a code deploy to change a model.

**Build the scoring router now with heuristic weights.** Rejected. Weights with no evaluation data are a random number generator wearing a lab coat. It would also produce confident-looking UI ("selected for quality/cost balance") that is not true, which violates the product's own principle 6 — the system admits what it does not know.

## Open items

- Source of truth for pricing and how often it is reviewed. **Unknown — must be resolved before any screen displays a dollar figure attributed to a model.**
- Whether `budgetUsd` is enforced pre-flight (reject a run whose estimate exceeds the ceiling) or reconciled post-hoc (record actual spend and alert). Pre-flight requires an estimate that does not exist without token forecasting. **Unknown — must be resolved before the cost gate in `IMPLEMENTATION-PLAN.md` unit E2.**
- Whether provider credentials live per-org (bring-your-own-key) or platform-wide. This changes the tenancy model of secrets and is not addressed by any current document.

## Revisit trigger

Revisit when an evaluation harness exists (routing then becomes a measurable decision rather than a lookup), when a second provider is actually connected (fallback and cost comparison become real), or when the first stale `asOf` price is detected in the seed. Do not build the router before the harness.

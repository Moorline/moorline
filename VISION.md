# Moorline Vision

Moorline is a local-first agent host focused on useful autonomy, strong memory, and clear human oversight.

This document defines durable direction. Implementation details should evolve, but all work should align with these principles.

## Product Direction

- Build a small, inspectable host with clear boundaries between core runtime code and installable runtime surfaces.
- Keep the core focused on runtime supervision, orchestration boundaries, policy, audit, state, recovery, package loading, and memory.
- Treat transports, providers, plugins, and skills as separate extension surfaces with distinct contracts and lifecycle expectations.
- Favor strong defaults over broad configuration in early and growth stages.
- Let operators manage the runtime through either a packaged CLI or an optional local web dashboard with equivalent control coverage.
- Preserve operator-owned files with built-in local history so AI or operator edits to tracked surfaces are auditable and reversible.

## System Shape

- `core` owns Moorline runtime behavior, durable state, memory infrastructure, policy, audit, recovery, and extension loading.
- `transports` are installable surfaces that connect Moorline to external interaction environments.
- `providers` are installable agent runtimes that execute work and may depend on bundled or external model access.
- `plugins` are installable behavior packages loaded through the same package model whether official or user-authored.
- `skills` are installable instruction assets that shape agent behavior without becoming privileged runtime code.
- The local web dashboard is an optional operator surface for setup, package management, diagnostics, and runtime control.
- The packaged CLI is a first-class operator surface and should be able to do the same core management work as the dashboard.

## Core Invariants

- Local-first operator ownership of state, packages, and configuration.
- Small core with explicit boundaries to transports, providers, plugins, and skills.
- Auditable and reversible actions.
- Bounded autonomy through explicit policy and permissions.
- Memory with provenance over opaque context stuffing.
- Extensibility through installable packages plus narrow contracts.
- Prefer supervised restart-and-recover over in-process hot reload.
- Provider and transport changes activate on restart or supervised reload, not arbitrary live mutation mid-turn.

## Interaction Model

- Moorline should support multiple operator surfaces without making any single transport the architectural center of the system.
- The local dashboard and CLI are management surfaces, not replacements for the runtime core.
- Transports should remain removable and replaceable without forcing core rewrites.
- User-facing interaction should stay simple while runtime orchestration, memory, and recovery remain host responsibilities.

## Memory Direction

- Treat memory as a first-class subsystem, not a chat transcript dump.
- Keep layered memory:
  - durable facts
  - thread or session memory
  - retrieval index over code, docs, and runtime artifacts
- Prefer retrieval with provenance over blind context stuffing.
- Use multiple search strategies before asking users to repeat context.

## Principles

- Vision-first: if work does not align with this document, call it out and propose an aligned alternative.
- Minimal global context and minimal prompts by default.
- Strong defaults for safety and observability.
- Ship narrow, then expand intentionally behind clear quality gates.
- Separate stable principles from changeable implementation strategy.

## Non-Goals

- Hot-swapping code inside a live runtime worker.
- Broad, unstable configuration surfaces before core behavior is proven.
- Treating official packages as privileged one-offs instead of real examples of the extension model.
- Letting a transport, provider, dashboard, or CLI become a substitute for the core runtime boundary.

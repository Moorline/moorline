# Moorline Vision

Moorline is an operator-controlled runtime for connecting external surfaces, providers, and packages into durable, auditable agent-powered work.

This document defines durable direction. Implementation details should evolve, but all work should align with these principles.

## Product Direction

- Build a small, inspectable runtime with clear boundaries between core orchestration code and installable package surfaces.
- Keep the core focused on durable work, runtime supervision, orchestration boundaries, policy, audit, state, recovery, package loading, and memory.
- Treat API adapters, transports, providers, plugins, skills, and bundles as separate package surfaces with distinct contracts and lifecycle expectations.
- Make Moorline extensible across many event sources, interaction surfaces, providers, and workflow ideas without making any one surface the architectural center.
- Favor strong defaults over broad configuration in early and growth stages.
- Let operators manage the runtime through the packaged CLI and API adapters with equivalent core management coverage.
- Preserve operator-owned runtime files with history so AI or operator edits to tracked surfaces are auditable and reversible.

## System Shape

- `core` owns Moorline runtime behavior, durable work and state, memory infrastructure, policy, audit, recovery, and package loading.
- `api adapters` expose Moorline control and management surfaces through protocols such as HTTP.
- `transports` connect Moorline to external event and interaction environments.
- `providers` are installable agent runtimes that execute work and may depend on bundled or external model access.
- `plugins` are installable behavior packages loaded through the same package model whether official or user-authored.
- `skills` are installable instruction assets that shape agent behavior without becoming privileged runtime code.
- `bundles` compose package sets without hiding the underlying package surfaces.
- The packaged CLI is a first-class operator surface.

## Core Invariants

- Operator control of runtime state, packages, configuration, policy, and audit, whether Moorline runs locally, on a server, or in another controlled environment.
- Small core with explicit boundaries to transports, providers, plugins, and skills.
- Auditable and reversible actions.
- Bounded autonomy through explicit policy and permissions.
- Memory with provenance over opaque context stuffing.
- Extensibility through installable packages plus narrow contracts.
- Prefer supervised restart-and-recover over in-process hot reload.
- Provider and transport changes activate on restart or supervised reload, not arbitrary live mutation mid-turn.

## Interaction Model

- Moorline should support many event sources, interaction surfaces, and operator surfaces without making any single transport the architectural center of the system.
- Chat is one useful transport shape, not the core product shape.
- API adapters, transports, providers, plugins, skills, and bundles should remain removable and replaceable without forcing core rewrites.
- User-facing interaction should stay simple while durable work orchestration, memory, audit, policy, and recovery remain host responsibilities.

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
- Letting a transport, provider, plugin, API adapter, dashboard, or CLI become a substitute for the core runtime boundary.
- Defining Moorline as local-only or laptop-first. Local execution is supported, but the durable boundary is operator control.

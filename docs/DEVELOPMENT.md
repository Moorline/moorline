# Development Guide

This document is for contributors and maintainers working on Moorline after the package split.

Moorline's core product shape is an operator-controlled runtime with explicit package boundaries. The host owns durable state, policy, audit, recovery, and orchestration. Packages supply API adapters, transports, providers, plugins, skills, and bundles.

## Local Dev Loop

```bash
bun install
bun run typecheck
bun run lint
bun run test:fast
bun run build
```

## Repo Shape

- `packages/contracts`: shared package/runtime contracts.
- `packages/core`: Moorline core runtime, config, state, policy, package services, and control-plane implementation.
- `packages/control-api`: typed route table, validators, HTTP client, and local connection-record helpers.
- `packages/http`: official HTTP API adapter.
- `packages/cli`: the unscoped `moorline` npm package and command.

Official provider, transport, plugin, skill, and bundle packages live in `Moorline/packages`. Package authoring, validation, and bundling tools live in `Moorline/kit`.

The workspace root is private and exists for workspaces, scripts, and dev tooling only.

## Package Rules

Official packages use short npm names like `@moorline/codex`, while Moorline package identity lives in metadata as `official/codex`.

Runtime package kinds are:
- `api-adapter`
- `transport`
- `provider`
- `plugin`
- `skill`

Bundles are metadata packages that reference those runtime package kinds.

## Control API

`@moorline/control-api` is the SDK/contract package. It must not depend on `@moorline/core` or host an HTTP server.

`@moorline/http` is the only shipped API adapter. It exposes JSON routes under `/api/*`, uses bearer-token auth, defaults to loopback-only, and relies on deployment infrastructure for TLS.

CLI commands can use an auto-discovered connection record or explicit remote options:
- `--url`
- `--token`
- `MOORLINE_API_URL`
- `MOORLINE_API_TOKEN`

## Config

Current config version is `4`.

Fresh config starts without a selected API adapter. `moorline init` discovers the bundled API adapter by manifest, installs it, and selects its package id. HTTP settings live in that package config, not under a top-level API object.

## Package Resources

Core resources live under `packages/core/resources`.

Runtime package installs use:
- `runtime/packages/api-adapters/...`
- `runtime/packages/providers/...`
- `runtime/packages/transports/...`
- `runtime/packages/plugins/...`
- `runtime/packages/skills/...`
- `runtime/packages/bundles/...`

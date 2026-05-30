# Dev Environment Setup

This is the fastest way to run Moorline 0.0.x locally.

## Prerequisites

- Bun 1.3.11+
- Node.js 22+
- Git
- `codex` installed on `PATH`
- successful `codex login status`

Docker is no longer the primary install path for Moorline 0.0.x.

## Clone and build

```bash
git clone git@github.com:Moorline/moorline.git
cd moorline
bun install
bun run build
```

## Initialize core runtime files

```bash
bun run moorline init
```

`moorline init` is core-only. It writes:
- config to `~/.moorline/config.json`
- runtime data under `~/.moorline/runtime` by default

## Install/select/apply transport and provider

```bash
bun run moorline configure
```

`moorline configure` guides you through installing and selecting one transport and one provider package, then applies the config.

## Start runtime

```bash
bun run moorline run
```

If setup is incomplete or package loading fails, `moorline run` starts the selected API adapter in management-only mode.

## Verify a basic managed-work path

1. Run `bun run moorline configure state` and confirm setup is complete.
2. In your configured transport, create a session and send a test message.
3. Confirm replies arrive and pending approvals (if applicable) are actionable.
4. Archive and delete the test session through transport commands or Moorline CLI/API commands.

## Fresh retest

Use this when you want a clean runtime without re-entering config:

```bash
bun run moorline reset
bun run moorline run
```

## Quality checks

```bash
bun run check
bun run test
```

## Dev readiness smoke (current flow)

Use this flow before calling a branch "ready to test in dev":

```bash
bun install
bun run check
bun run build
```

Then run a clean runtime smoke with local installable archives:

```bash
export MOORLINE_HOME="$(mktemp -d /tmp/moorline-devflow-XXXXXX)"
export MOORLINE_PACKAGES_REPO="../packages"

bun run moorline init
bun run moorline configure package install --kind bundle --source "$MOORLINE_PACKAGES_REPO/dist/installable-archives/bundles/moorline-bundle-discord-default-0.0.1.tar.gz"
bun run moorline configure package install --kind bundle --source "$MOORLINE_PACKAGES_REPO/dist/installable-archives/bundles/moorline-bundle-codex-default-0.0.1.tar.gz"
bun run moorline configure package config --surface provider --package official/codex --key command --value codex
bun run moorline configure package config --surface transport --package official/discord --key authToken --value test-token
bun run moorline configure package config --surface transport --package official/discord --key scopeId --value scope-123
bun run moorline configure apply
timeout 15s bun run moorline run || test $? -eq 124
```

Notes:
- with dummy Discord values, `moorline configure apply` may log token/auth failures while deriving bot metadata; use real Discord credentials when smoke-testing the full apply path
- published releases install official bundles from public package artifacts; local archives from `Moorline/packages` remain the stable path for unreleased branch work

Clean up temp runtime state when done:

```bash
rm -rf "$MOORLINE_HOME"
```

## Common issues

- `moorline configure` or provider startup fails on Codex auth:
  Run `codex login status` and fix local auth first.
- Setup does not finish:
  Run `bun run moorline configure state` and address `Startability blockers` or dependency errors.
- Transport verification fails:
  Confirm transport credentials/config keys were set correctly with `moorline configure package config set`.
- Managed transport resources are missing:
  Check the active transport package docs, then restart with `moorline run` after repairing native resources.

# Operator Runbook

This runbook covers the current Moorline operator flow.

## First Install

Normal operator install uses a packaged CLI archive.

Inside that archive you get:
- `moorline`
- on Windows, `moorline.cmd`
- a bundled Node runtime
- a sibling `resources/` directory

Repo checkout install remains useful for development:
```bash
bun install
bun run build
```

Initialize the core scaffold:
```bash
moorline init
```

`moorline init` creates:
- `~/.moorline/config.json`
- `~/.moorline/runtime/`
- `~/.moorline/.git`
- empty managed install roots for API adapters, providers, transports, plugins, and skills

It selects the built-in `official/http` API adapter by default so local and remote CLI clients have a control endpoint. It does not install or select provider, transport, plugin, or skill packages.

## Complete Setup

Use:
```bash
moorline configure
```

If setup is incomplete, `moorline run` starts management-only mode.

A complete setup requires:
- one active API adapter
- one active transport
- one active provider
- valid package config
- an explicit apply

Fresh `moorline init` selects the built-in `official/http` API adapter. Official setup recommends the `official/discord-default`, `official/codex-default`, and `official/basic-essentials` bundles. Every recommendation is optional; skipping plugins does not block setup readiness.

Package families:
- installables: API adapters, providers, transports, plugins
- add-ons: skills

## Runtime Mode Matrix

Operator-supported session modes:
- `full-access`: no approval gate.
- `approval-required`: protected actions require approval.

## Managed Namespace Role Setup And Recovery

Managed namespace defaults include:
- `Moorline` (main managed category)
- `#moorline-chat` (managed chat channel)
- `#moorline-status` (managed status channel)
- `Moorline Sessions` (managed sessions category)
- `Moorline Missions` (managed missions category)
- `Moorline Archive` (managed archive category)
- `Moorline Admin` (operator control role)
- `Moorline User` (managed runtime interaction role)

Setup checklist:
- keep `admin.managedRole.enabled: true` and `admin.managedUserRole.enabled: true` unless you intentionally run explicit manual role mapping
- assign `Moorline Admin` to operators who should run `/admin` controls
- assign `Moorline User` to members who should use managed interaction paths
- verify `#moorline-chat`, `#moorline-status`, `Moorline Sessions`, `Moorline Missions`, and `Moorline Archive` exist

Recovery checklist:
- if managed roles or channels are renamed/moved, restart `moorline run` or run `/admin reload mode:graceful` to reconcile tracked resources
- if users are blocked, reassign `Moorline User` and confirm channel permission overwrites include that role
- run `moorline api status`, `moorline main status`, and `moorline configure state` to verify control-plane, runtime, and setup health after recovery

## Shareable Config And Secrets

Moorline separates config into:

- `~/.moorline/config.json`
- `~/.moorline/config.secrets.json`

Rules:
- `config.json` is intended to be shareable
- `config.secrets.json` is not shareable
- local Git history ignores `config.secrets.json`
- Share Setup exports only the public config and package state
- applied runtime config uses `transport` and `provider`

If Moorline detects tracked history that likely contains secrets from an earlier config state, it backs that repo up and starts a fresh sanitized repo.
Do not upload the backup repo.

## Share Setup

CLI:
```bash
moorline configure setup-export
moorline configure setup-export --out ./moorline-setup.share.json
```

The exported bundle:
- excludes secrets
- includes selected/enabled package state
- includes portable remote archive sources when available
- marks local-path installs as `local_only`

## Normal Startup

Start the runtime:
```bash
moorline run
```

Outcomes:
- if setup is incomplete, Moorline starts management-only mode
- if setup is complete, the selected API adapter and supervised runtime worker start

## Operator Checks

Run:
```bash
moorline api status
moorline main status
moorline configure state
moorline history status
moorline history list
```

Use these checks to verify:
- runtime storage support
- packaged release vs source checkout mode
- release manifest and asset root
- official catalog checksum integrity
- provider installation/auth
- applied transport config
- namespace state
- persisted provider binding health
- recorded package load failures

Source-checkout note:
- missing official package archives no longer blocks basic commands.
- catalog integrity checks may report missing generated archive metadata in that state.
- catalog package installs (`moorline configure package install --kind <kind> --package <id>`) still enforce recommended checksums.
- build official package archives in `Moorline/packages` before release validation:
```bash
cd ../packages
bun run build
```

## Manual Release Gate

Before a manual host release, run the local release gate:
```bash
bun run check
bun run test
bun run build
bun run build:cli-artifact -- --platform linux-x64 --archive-format tar.gz
```

Smoke the packaged Unix CLI:
```bash
smoke_dir="$(mktemp -d /tmp/moorline-cli-smoke-XXXXXX)"
config_path="$smoke_dir/moorline-ci-config.json"
tar -xzf dist/release-artifacts/moorline-cli-linux-x64.tar.gz -C "$smoke_dir"
"$smoke_dir/moorline-cli-linux-x64/moorline" help
MOORLINE_HOME="$smoke_dir/home" "$smoke_dir/moorline-cli-linux-x64/moorline" init --config "$config_path"
MOORLINE_HOME="$smoke_dir/home" timeout 10s "$smoke_dir/moorline-cli-linux-x64/moorline" run --config "$config_path" || test $? -eq 124
rm -rf "$smoke_dir"
```

Then run the GitHub release workflow manually with `workflow_dispatch`.
The workflow builds and smokes artifacts without uploading GitHub release assets or publishing npm packages.

## Release Smoke

Release confidence is provided by `bun run check`, `bun run test:full`, and packaged CLI smoke checks in CI/release workflows.

Build the repo:
```bash
bun run build
```

Create a temporary release-smoke home and config:
```bash
export MOORLINE_HOME="$(mktemp -d)"
export MOORLINE_CONFIG="$MOORLINE_HOME/config.json"
node packages/cli/dist/main.js init --config "$MOORLINE_CONFIG"
node packages/cli/dist/main.js run --config "$MOORLINE_CONFIG"
```

Using CLI package commands against the printed API endpoint or local connection record, verify:
- `Recommended Setup` is visible
- `official/discord-default`, `official/codex-default`, and `official/basic-essentials` are listed
- each bundle can be inspected for included packages
- `Install` works for a recommended bundle
- bundle installation selects or enables member packages according to the bundle manifest
- leaving a recommendation uninstalled is allowed

Use `moorline configure setup-export` and verify:
- it writes `moorline-setup.share.json`
- the file contains package selections
- the file does not contain secrets

Clean up the temporary home:
```bash
rm -rf "$MOORLINE_HOME"
```

## Package Management

Install and inspect packages:
```bash
moorline configure packages catalog
moorline configure packages installed
moorline configure package install --kind bundle --package official/discord-default
moorline configure package install --kind bundle --package official/codex-default
moorline configure package install --kind plugin --source ./my-plugin-bundle
moorline configure package install --kind plugin --source ./my-plugin-bundle.tar.gz
moorline configure package select --surface transport --package official/discord
moorline configure package select --surface provider --package official/codex
moorline configure package config --surface transport --package official/discord --key authToken --value <token>
moorline configure package config --surface transport --package official/discord --key scopeId --value <scope-id>
moorline configure package config --surface provider --package official/codex --key command --value codex
moorline configure apply
```

Useful commands:
- `moorline configure package remove`
- `moorline configure package enable`
- `moorline configure package disable`
- `moorline configure package deps`

Normal install sources:
- local directory bundles
- local archive bundles
- remote archive URLs

## Local History

Moorline local history is for tracked operator-owned files:

```bash
moorline history list
moorline history snapshot "before policy edit"
moorline history diff
moorline history restore <commit-ish>
moorline history discard --path runtime/packages/plugins/official/persona/SOUL.md
```

Tracked by default:
- `config.json`
- installed installables and add-ons
- policies
- skills
- persona files

Not tracked:
- `config.secrets.json`
- runtime DB/state/logs/chat/workspaces/memory

## Backup

Preferred backup path:
```bash
moorline configure backup --out ~/moorline-backup.tgz
```

Include workspaces when needed:
```bash
moorline configure backup --out ~/moorline-backup-full.tgz --include-workspaces
```

Legacy/minimum safe backup:
```bash
tar -czf moorline-backup.tgz \
  ~/.moorline/config.json \
  ~/.moorline/config.secrets.json \
  ~/.moorline/runtime
```

Importing a backup:
```bash
moorline configure import ~/moorline-backup.tgz
```

If local runtime state is non-empty, import fails unless `--force` is provided:
```bash
moorline configure import ~/moorline-backup.tgz --force
```

`--force` deletes current runtime state before restore.
Leave `--force` off to run a safety-check import that fails when local state already exists.

For sharing with another operator, use `moorline configure setup-export` instead of copying `config.secrets.json`.

## Memory Ops

Check memory/index status:
```bash
moorline memory status
```

Search memory with provenance references:
```bash
moorline memory search "query text"
```

## Secret Rotation

Rotate secrets by updating package config through the CLI.
Secret values are stored in `config.secrets.json`.

After rotating transport or provider secrets:
```bash
moorline configure apply
moorline run
```

## Runtime Support Note

Moorline `0.0.x` currently depends on `node:sqlite`.
This is an accepted risk for this release line.
The shipped CLI archive runs on the bundled Node runtime.
Repo development remains Bun-first.
Use:
- Bun `1.3.x+` in the repo
- Node `22+` for runtime compatibility

Before publishing a CLI archive, run:

```bash
bun run validate:release-runtime
```

That command must pass on the Node runtime being bundled or used for release validation.

If startup reports missing `node:sqlite` support, fix the runtime before opening an issue against runtime behavior.

## Official npm Package Artifacts

Official package npm-compatible artifacts live in `Moorline/packages`.

The initial public npm artifacts are:

- `@moorline/basic-essentials@0.0.1`
- `@moorline/codex-default@0.0.1`
- `@moorline/discord-default@0.0.1`

Build official npm-compatible package directories and tarballs:

```bash
cd ../packages
bun run build:official-npm-packages
```

Outputs:

```text
dist/npm-packages/
dist/npm-tarballs/
dist/npm-packages/moorline-npm-summary.json
```

Publishing is manual:

```bash
npm publish dist/npm-packages/@moorline/discord-default --access public
```

Do not ask users to run `npm install` for Moorline packages. Users should install through:

```bash
moorline package search discord
moorline package info official/discord-default --kind bundle
moorline package install official/discord-default --kind bundle
```

# Moorline

Moorline 0.0.x is an operator-controlled runtime for connecting external surfaces, providers, and packages into durable, auditable agent-powered work.

Its core job is orchestration: receive work from transports or external events, bind that work to durable runtime state, route it through providers and plugins, and keep the resulting sessions, gates, policy decisions, audit logs, and recovery state inspectable.

The shipped operator surfaces are:
- `moorline` for setup, package management, runtime control, history, and Control API access
- the bundled HTTP API adapter package used by local or remote CLI clients

Moorline does not require a hosted relay. It can run on an operator machine, a server, or another operator-controlled environment. The operator controls the runtime packages, provider and transport selection, policy, state, secrets, and audit trail.

## Repo Layout

Source is split by platform boundary:
- `packages/contracts/`: shared runtime, package, provider, transport, plugin, skill, and API-adapter contracts
- `packages/core/`: Moorline engine code only, grouped into `runtime/`, `domain/`, `system/`, `extension/`, and `shared/`
- `packages/control-api/`: typed route table, request validation, client, and local connection discovery
- `packages/http/`: official HTTP API adapter
- `packages/cli/`: the unscoped `moorline` npm package and command

Official provider, transport, plugin, skill, and bundle packages live in `Moorline/packages`. Package authoring tooling lives in `Moorline/kit`.

## Quickstart

### Prerequisites
- Bun 1.3.11+
- Node.js 22+

### Install

Published CLI install:

```bash
npm install -g moorline
moorline run
```

Source checkout install:

```bash
git clone git@github.com:Moorline/moorline.git
cd moorline
bun install
bun run build
```

### First-run setup
```bash
bun run moorline run
```

`bun run moorline` uses the Node-backed CLI entrypoint (`packages/cli/dist/main.js`) so runtime commands execute with Node.js `node:sqlite` support.

`bun run moorline run` starts the Control API and prints:
- control API URL
- bearer token for headless/API clients

Use Control API-backed CLI commands to complete package setup. Local commands can auto-discover the local connection record, and remote commands can use `--url`, `--token`, `MOORLINE_API_URL`, and `MOORLINE_API_TOKEN`.

If setup is incomplete, the Control API stays in management-only mode so you can install, select, configure, and apply one API adapter, one transport, and one provider.

Install package bundles or individual packages for the transport, provider, plugins, and skills you want to run. Bundles install and activate their member packages while keeping every underlying API adapter, provider, transport, plugin, and skill independently inspectable. Optional bundles do not block setup readiness; setup readiness depends on one active API adapter, one active transport, and one active provider.

Package trust note:
- API adapter, provider, transport, and plugin packages are trusted runtime code once activated
- bundle packages are metadata-only package groups; their members carry the runtime behavior
- package validation checks structure, metadata, and install safety; Moorline does not sandbox arbitrary JavaScript package code
- install third-party runtime packages only from sources you are willing to execute in the operator-controlled environment

Source-checkout note for unreleased branches:
- published releases install official bundles from the public package artifacts
- unreleased branch work can still build `Moorline/packages` locally and install from its `dist/installable-archives/` output via:
  - `bun run moorline configure package install --kind bundle --source <path-to-bundle-archive>`
  - `bun run moorline configure package install --kind transport --source <path-to-transport-archive>`
  - `bun run moorline configure package install --kind provider --source <path-to-provider-archive>`

### Run
```bash
bun run moorline run
```

Core API-backed commands:

```bash
bun run moorline api start
bun run moorline api status
bun run moorline main start --token <api-token>
bun run moorline ops state --token <api-token>
bun run moorline ops accepting on --token <api-token>
bun run moorline configure state --token <api-token>
bun run moorline requests list --token <api-token>
```

The Control API exposes canonical JSON routes under `/api/*`.

### Diagnose and restore
```bash
bun run moorline api diagnostics-export --token <api-token>
bun run moorline history status
bun run moorline history list
```

### Backup and import
Backup runtime state (excludes workspaces by default):

```bash
bun run moorline configure backup --token <api-token> --out ~/moorline-backup.tgz
```

Include session workspaces in the archive:

```bash
bun run moorline configure backup --token <api-token> --out ~/moorline-backup-full.tgz --include-workspaces
```

Import a backup into an empty target runtime:

```bash
bun run moorline configure import ~/moorline-backup.tgz --token <api-token>
```

If runtime state already exists, import fails unless `--force` is provided:

```bash
bun run moorline configure import ~/moorline-backup.tgz --force --token <api-token>
```

`--force` wipes current runtime state before restoring from the archive.

## Runtime Behavior

Moorline uses the active provider package for model and turn execution.

Runtime work can start from chat-like messages, transport-native actions, external events, scheduled package jobs, or plugin-managed work queues. Chat is one transport shape, not the architectural center.

### Admin control

Configure admin authority in `~/.moorline/config.json`:

```json
{
  "admin": {
    "roleIds": ["discord-role-id"],
    "userIds": ["discord-user-id"],
    "allowTransportAdmin": false,
    "managedRole": {
      "enabled": true,
      "name": "Moorline Admin"
    }
  }
}
```

Admin authority is explicit by default, with a managed Moorline-scoped role bootstrapped automatically unless you disable it:
- `roleIds` and `userIds` remain explicit operator-controlled admin identities
- `managedRole.enabled` controls whether Moorline creates and uses its dedicated admin role
- `managedRole.name` lets you rename that dedicated Moorline-only role
- `allowTransportAdmin` can optionally allow transport-native elevated permissions to count as admin authority

### Main chat
- bound by the active transport package
- provider-backed
- uses the configured default runtime mode
- intended for coordination, status, and lightweight help
- shares the managed chat workspace under the runtime root

### Sessions
- created by the active transport/plugin package surface
- each session gets its own local workspace under the runtime root
- session messages run through the active provider in the session workspace

### Model selection
Provider packages can expose model-listing and model-selection commands through plugins.

### Runtime Modes

Moorline 0.0.x operator-facing session modes:
- `full-access`: the active provider runs with full local access and no approval gate.
- `approval-required`: protected provider actions request approval before they continue.

Both modes run inside the configured runtime environment. `approval-required` adds operator review, not host isolation.

## Runtime State And History

By default, Moorline stores operator-owned runtime state under `~/.moorline/`. Deployments may place this home directory on an operator machine, a server, or another controlled environment.

Tracked local history lives at:
- `~/.moorline/.git/`

Tracked history covers:
- `config.json`
- `runtime/packages/`
- `runtime/policies/`

Ignored runtime-working data includes:
- `chat/`
- `memory/`
- `logs/`
- `state/`
- `state.db`
- `workspaces/`

Use local history to inspect, snapshot, restore, and discard tracked changes:

```bash
bun run moorline history status
bun run moorline history snapshot "before provider edit"
bun run moorline history restore <commit-ish>
bun run moorline history discard --path runtime/packages/plugins/official/persona/SOUL.md
```

Config is separate by default:
- `~/.moorline/config.json`

## Notes

- `approval-required` adds operator approval, not machine isolation.
- plugin, skill, provider, and transport package edits under the runtime root are operator-owned surfaces; Moorline does not require a source checkout to run.
- if you modify visible runtime packages or upgrade the installed package, use `/admin reload mode:graceful` when admin control is configured, or restart `moorline run` to reload and reconcile the visible runtime surfaces.

## Development

If you are developing Moorline itself rather than operating it, use:
- `docs/DEVELOPMENT.md`
- `docs/RUNBOOK.md`

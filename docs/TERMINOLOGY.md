# Terminology

This document is the naming source-of-truth for:

- user-facing docs
- operator docs
- CLI copy
- internal engineering docs

Use the preferred term here unless there is a specific compatibility reason not to.

## Usage Rule

When writing copy or docs, distinguish between:

- user-facing terms
- operator/admin terms
- internal engineering terms

Do not casually swap between them. If an internal term is clearer for engineering, keep it in engineering docs and avoid pushing it into product copy unless it is intentionally user-visible.

## User-Facing Terms

These are the safest default words for product copy.

- `Moorline`
  - The product name.
- `CLI`
  - The packaged `moorline` command-line interface.
- `setup`
  - The first-time operator flow for installing, selecting, configuring, and applying required packages.
- `package`
  - The general user-facing umbrella word for installable Moorline extensions and package groups.
- `provider`
  - A package that powers the agent runtime.
- `transport`
  - A package that connects Moorline to an external surface such as Discord.
- `plugin`
  - A package that adds runtime tools, commands, hooks, or integrations.
- `skill`
  - A package that adds reusable skill content.
- `bundle`
  - A package that installs and activates a curated set of other packages.
- `recommended`
  - Preferred for first-run suggestions from the official catalog.
- `installed`
  - Present in the runtime.
- `activated`
  - Turned on for runtime use. Use for providers, transports, plugins, and skills.
- `deactivated`
  - Installed but not turned on for runtime use.
- `apply`
  - The explicit action that activates staged package or config changes.
- `share setup`
  - The sanitized setup export feature.
- `local history`
  - The advanced restore/history feature in product copy.
- `snapshot`
  - A named restore point.
- `restore`
  - Return tracked files to a previous version.
- `management-only mode`
  - Runtime state where Moorline starts only the configured API adapter because setup is incomplete.

## Operator And Admin Terms

These are acceptable in runbooks, setup guidance, and API/CLI-oriented admin docs.

- `operator`
  - The human administering a local Moorline runtime.
- `operator surface`
  - The CLI or another API client used to manage Moorline.
- `catalog`
  - The available package listing shown by Moorline.
- `official package`
  - A package shipped and maintained by Moorline.
- `custom package`
  - A non-official package installed by the operator.
- `release asset`
  - A downloadable archive published for a package release.
- `remote archive`
  - A package archive installed from a URL.
- `dependency`
  - A required relationship between packages.
- `pending changes`
  - Desired config or package state not yet applied.
- `applied state`
  - The currently active runtime package state.
- `shareable config`
  - `~/.moorline/config.json`.
- `secret config`
  - `~/.moorline/config.secrets.json`.
- `share bundle`
  - The file exported by `moorline configure setup-export`.
- `checkpoint`
  - An automatic local-history commit created after tracked changes.

## Internal Engineering Terms

These are valid in code, architectural docs, and implementation notes.

- `core`
  - Moorline engine, storage, history, config, runtime coordination, and extension contracts.
- `app`
  - The packaged CLI launcher and bundled runtime resources.
- `package family`
  - The top-level grouping of a package as an installable or add-on.
- `package kind`
  - The concrete package type: api-adapter, provider, transport, plugin, skill, or bundle.
- `installable`
  - An executable package family member that may carry bundled runtime JavaScript dependencies.
- `add-on`
  - A lightweight content package family member that does not carry bundled runtime JavaScript dependencies.
- `surface`
  - Legacy internal name for runtime package kind. Prefer `package kind` for new code.
- `runtime root`
  - The managed runtime directory, usually `~/.moorline/runtime`.
- `desired state`
  - The staged package/config state in config.
- `inventory`
  - The installed package record in runtime state.
- `directory bundle`
  - An unpacked finished package artifact ready for installation.
- `archive bundle`
  - A finished package artifact distributed as `.tar.gz` or `.zip`.
- `remote archive`
  - A release-hosted archive bundle addressed by URL.
- `raw source tree`
  - Authoring source files, not the normal install format.
- `distro metadata`
  - Data from `moorline.dist.json`.
- `manifest`
  - Runtime contract data from `manifest.json`.
- `local history`
  - Git-backed history for operator-owned files under `~/.moorline/`.
- `contracts`
  - The publishable package spec and validation surface shared by the app and third-party authors.
- `package-kit`
  - The publishable authoring tool used to bundle, validate, and inspect packages.

## Package Kinds

Preferred definitions:

- `api-adapter`
  - Installable package that exposes the Moorline control API through a protocol such as HTTP.
- `provider`
  - Installable package that supplies agent-runtime behavior.
- `transport`
  - Installable package that supplies the external interaction surface.
- `plugin`
  - Installable package that extends runtime behavior with hooks, tools, commands, or integrations.
- `skill`
  - Add-on package that supplies content-only skill material.
- `bundle`
  - Metadata-only package that declares member packages plus install/select/enable behavior.

## Package States

Use these precisely:

- `installed`
  - Present in the managed runtime root.
- `activated`
  - Turned on for runtime use in desired config or applied inventory, depending on context.
- `deactivated`
  - Installed but not activated.
- `applied`
  - Activated in runtime inventory after an explicit apply.
- `activation key`
  - A uniqueness key that allows only one activated package in a slot, such as `api-adapter`, `provider`, or `transport`.
- `owned by bundle`
  - Installed as a member of a bundle. Removing the bundle removes owned members unless another bundle, a manual install, or a dependent package still needs them.

## Config And Sharing Terms

- `config.json`
  - Shareable public config.
- `config.secrets.json`
  - Unshared secret config.
- `public config`
  - Synonym for `config.json` in engineering docs.
- `secret field`
  - A config-schema property marked with `secret: true`.
- `share setup`
  - Preferred user-facing feature label.
- `share bundle`
  - Preferred internal and file-format term.

## History Terms

- `local history`
  - Preferred user-facing and operator-facing label.
- `checkpoint`
  - Automatic commit after tracked Moorline changes.
- `snapshot`
  - Operator-created named commit.
- `discard`
  - Drop tracked working-tree changes back to the last commit.
- `restore`
  - Write a previous tracked version back into the working tree and create a forward restore commit.

## Internal File And Metadata Terms

- `manifest.json`
  - Runtime contract file for a package.
- `moorline.dist.json`
  - Distribution and discovery metadata file.
- `runtime package`
  - Internal term for the loaded api-adapter, provider, or transport package contract object.
- `runtime plugin`
  - Internal term for the loaded plugin contract object.

## Deprecated Or Avoided Language

- `package surfaces`
  - Prefer `packages`, `package kinds`, or the specific package kinds.
- `installable skills`
  - Prefer `skill add-ons`.
- `dashboard`
  - Avoid. Moorline no longer ships a browser operator surface.
- `bundled defaults`
  - Avoid. Prefer `recommended bundles` or `recommended official packages`.
- `seeded official packages`
  - Avoid. Packages are installed explicitly through setup or package management.

## Quick Mapping

- user-facing:
  - `CLI`
  - `share setup`
  - `active provider`
  - `active transport`
  - `local history`
- operator/admin:
  - `catalog`
  - `pending changes`
  - `applied state`
  - `checkpoint`
- internal:
  - `installable`
  - `add-on`
  - `desired state`
  - `inventory`
  - `directory bundle`
  - `archive bundle`

# Transport Intents And Effects

Moorline 0.1.0 uses a breaking transport contract:

- transports emit `RuntimeTransportIntent` values into core;
- core records each intent before processing it;
- core owns durable session, work, policy, and audit state;
- core emits `RuntimeTransportEffect` values back to the active transport for visible/native side effects.

There is no legacy transport event API in this version. A transport is valid only if it can subscribe with `onIntent` and apply effects with `applyEffect`.

## Inbound Intents

Use intents for native events that should affect Moorline:

- `transport.session.ensure`: bind or create a Moorline session for a native resource, such as a Discord channel, GitHub issue, email thread, or chat room.
- `transport.session.delete`: delete the Moorline session bound to a native resource.
- `transport.session.archive`: archive runtime session state without requiring any native archive location.
- `transport.session.resume`: resume an archived or cooled runtime session.
- `transport.message.received`: deliver a user message to the session bound to the native resource.
- `transport.action.invoked`: deliver a transport-native action, such as `/status` or an interaction button.
- `transport.external.received`: deliver a non-message external event to plugins.
- `transport.resource.observed`: record native resource observation for audit/debugging only.

`transport.resource.observed` does not create, archive, or delete sessions. Transports decide which native facts matter and emit the explicit session intent when Moorline state should change.

## Outbound Effects

Use effects for visible/native work requested by Moorline:

- `transport.message.send`: post a message to a native target.
- `transport.presence.set`: expose status where the transport supports presence.
- `transport.actions.register`: register native actions.
- `transport.resource.create`: ask the transport to create a native resource for a Moorline-initiated session.
- `transport.resource.update`: ask the transport to update a native resource.
- `transport.resource.delete`: ask the transport to delete a native resource.

The transport returns a `RuntimeTransportEffectReceipt`. Resource create effects should return the created resource in `metadata.resource`.

## Session Ownership

Transports can be channel-like, issue-like, thread-like, email-like, or single-room chat-like. Core does not infer sessions from parent IDs, categories, labels, folders, or archive areas.

Examples:

- GitHub Issues: issue opened emits `transport.session.ensure`; issue comment emits `transport.message.received`; issue closed can emit `transport.session.archive` or `transport.session.delete`.
- Email: a new thread emits `transport.session.ensure`; replies emit `transport.message.received`; trash/archive actions are transport decisions.
- Chat with channels: channel create emits `transport.session.ensure`; channel delete emits `transport.session.delete`.
- Single-channel chat: the transport may map the whole room to one stable session and emit messages against that resource.

Archived sessions wake automatically when a message intent arrives for their resource.

## Plugin Hooks

Plugin hooks use the same vocabulary:

- `onTransportIntent`
- `onExternalEvent`
- `onAction`

Older `onTransportEvent` hooks are not supported in 0.1.0.

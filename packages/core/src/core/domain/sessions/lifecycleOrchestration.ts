interface LifecycleNotification {
  text: string;
  blocks: Array<{
    kind: 'fields';
    title: string;
    fields: Array<{ label: string; value: string; inline?: boolean }>;
    metadata: { timestamp: string };
    tone: 'default' | 'info' | 'warning';
  }>;
}

export function buildLifecycleNotification(input: {
  state: 'hot' | 'cool' | 'archived';
  sessionId: string;
  detail: string;
  nowIso?: string;
}): LifecycleNotification {
  return {
    text: input.detail,
    blocks: [
      {
        kind: 'fields',
        title: 'Session Lifecycle',
        fields: [
          { label: 'State', value: input.state, inline: true },
          { label: 'Session', value: input.sessionId }
        ],
        metadata: { timestamp: input.nowIso ?? new Date().toISOString() },
        tone: input.state === 'hot' ? 'info' : input.state === 'cool' ? 'warning' : 'default'
      }
    ]
  };
}

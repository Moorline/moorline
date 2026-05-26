interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface EmbedPayload {
  title: string;
  description?: string;
  color?: number;
  fields: EmbedField[];
  timestamp: string;
}

export function buildHealthEmbed(input: {
  uptimeSeconds: number;
  dbOk: boolean;
  environmentOk: boolean;
  activeSessions: number;
  coolSessions?: number;
  archivedSessions?: number;
}): EmbedPayload {
  return {
    title: 'Moorline Health',
    color: input.dbOk && input.environmentOk ? 0x2ecc71 : 0xe74c3c,
    fields: [
      { name: 'Uptime', value: `${input.uptimeSeconds}s`, inline: true },
      { name: 'Database', value: input.dbOk ? 'OK' : 'FAIL', inline: true },
      { name: 'Environment', value: input.environmentOk ? 'OK' : 'FAIL', inline: true },
      { name: 'Open Sessions', value: String(input.activeSessions), inline: true },
      { name: 'Cool Sessions', value: String(input.coolSessions ?? 0), inline: true },
      { name: 'Archived Sessions', value: String(input.archivedSessions ?? 0), inline: true }
    ],
    timestamp: new Date().toISOString()
  };
}

export function buildErrorEmbed(reason: string): EmbedPayload {
  return {
    title: 'Runtime Error',
    description: reason,
    color: 0xe74c3c,
    fields: [{ name: 'Status', value: 'Action blocked (fail-closed).' }],
    timestamp: new Date().toISOString()
  };
}

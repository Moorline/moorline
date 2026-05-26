import type { RuntimeModeName } from '../../../types/runtime.js';
import { parseMissionSchedule, parseMissionStartTime } from './missionSchedule.js';

export interface DraftMissionSetupInput {
  goal: string;
  schedule: string;
  startTime?: string;
  runtimeMode?: RuntimeModeName;
}

type DraftMissionField = 'goal' | 'schedule' | 'start' | 'mode';

function readFields(content: string): Partial<Record<DraftMissionField, string>> {
  const fields = new Map<DraftMissionField, string[]>();
  let currentField: DraftMissionField | null = null;

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(?:[-*]\s*)?(goal|schedule|start|mode)\s*:\s*(.*)$/iu);
    if (match) {
      currentField = match[1].toLowerCase() as DraftMissionField;
      const current = fields.get(currentField) ?? [];
      if (match[2].trim()) {
        current.push(match[2].trim());
      }
      fields.set(currentField, current);
      continue;
    }
    const unknownField = line.match(/^(?:[-*]\s*)?([a-z][a-z0-9_-]*)\s*:/iu);
    if (unknownField) {
      throw new Error(
        `unknown field "${unknownField[1]}". Allowed fields are goal, schedule, start, and mode.`
      );
    }
    if (!currentField) {
      throw new Error(
        `unexpected content before the first field: "${line}". Start with "goal:" and "schedule:".`
      );
    }
    const current = fields.get(currentField) ?? [];
    current.push(line);
    fields.set(currentField, current);
  }

  const value = (name: DraftMissionField): string | undefined => {
    const parts = fields.get(name);
    if (!parts || parts.length === 0) {
      return undefined;
    }
    const joined = parts.join(' ').trim();
    return joined.length > 0 ? joined : undefined;
  };

  return {
    goal: value('goal'),
    schedule: value('schedule'),
    start: value('start'),
    mode: value('mode')
  };
}

export function parseDraftMissionSetupMessage(content: string): DraftMissionSetupInput | null {
  const normalized = content.trim();
  if (!normalized) {
    return null;
  }

  const fields = readFields(normalized);
  const goal = fields.goal;
  const schedule = fields.schedule;
  if (!goal || !schedule) {
    throw new Error('draft mission setup requires both goal and schedule fields.');
  }

  const startTime = fields.start;
  const mode = fields.mode?.toLowerCase();
  const runtimeMode =
    mode === undefined
      ? undefined
      : mode === 'full-access' || mode === 'approval-required'
        ? mode
        : null;
  if (runtimeMode === null) {
    throw new Error('mode must be full-access or approval-required.');
  }
  parseMissionSchedule(schedule);
  if (startTime) {
    parseMissionStartTime(startTime, new Date().toISOString());
  }

  return {
    goal,
    schedule,
    ...(startTime ? { startTime } : {}),
    ...(runtimeMode ? { runtimeMode } : {})
  };
}

export function buildDraftMissionSetupPrompt(input: { title: string; missionId: string }): string {
  return [
    `Moorline adopted this space as draft mission ${input.missionId}.`,
    `Reply here with the mission details in this format to finish setup for "${input.title}":`,
    '',
    'goal: describe the ongoing objective',
    'schedule: every hour',
    'start: 09:00',
    'mode: approval-required',
    '',
    'Only goal and schedule are required.',
    'You can also finish setup through Moorline CLI/API configuration commands.'
  ].join('\n');
}

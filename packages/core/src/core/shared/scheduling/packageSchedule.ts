const UNIT_TO_MINUTES: Record<string, number> = {
  minute: 1,
  minutes: 1,
  min: 1,
  mins: 1,
  hour: 60,
  hours: 60,
  day: 1440,
  days: 1440
};

const MONTH_ALIASES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const DOW_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
  expression: string;
}

type PackageScheduleMeta =
  | {
      kind: 'interval';
      intervalMinutes: number;
    }
  | {
      kind: 'cron';
      cronExpression: string;
    }
  | {
      kind: 'once';
      runAt: string;
    };

interface ParsedPackageSchedule {
  cadenceMinutes: number;
  normalized: string;
  meta: PackageScheduleMeta;
}

function parsePositiveInt(input: string, label: string): number {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function hasExplicitTimezone(input: string): boolean {
  return /(?:z|[+-]\d{2}:\d{2})$/i.test(input.trim());
}

function parseTimeOfDay(input: string, nowIso: string): string | null {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3] ?? '0', 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    throw new Error('start_time time-of-day must be in HH:MM or HH:MM:SS format.');
  }
  const now = new Date(nowIso);
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    seconds,
    0
  ).toISOString();
}

function parseLocalDateTime(input: string): string | null {
  const match = input
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2}))?)?$/i);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10) - 1;
  const day = Number.parseInt(match[3], 10);
  const hours = Number.parseInt(match[4] ?? '0', 10);
  const minutes = Number.parseInt(match[5] ?? '0', 10);
  const seconds = Number.parseInt(match[6] ?? '0', 10);
  if (month < 0 || month > 11 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error('start_time date-time components are out of range.');
  }
  const parsed = new Date(year, month, day, hours, minutes, seconds, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hours ||
    parsed.getMinutes() !== minutes ||
    parsed.getSeconds() !== seconds
  ) {
    throw new Error('start_time must be a valid calendar date and local time.');
  }
  return parsed.toISOString();
}

function parseAbsoluteTimestamp(input: string): string {
  const trimmed = input.trim();
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(trimmed)) {
    throw new Error('One-shot schedules must use an absolute timestamp, not HH:MM only.');
  }

  const localDateTime = parseLocalDateTime(trimmed);
  if (localDateTime) {
    return localDateTime;
  }
  if (hasExplicitTimezone(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      throw new Error('One-shot schedule timestamp is not valid ISO date-time.');
    }
    return new Date(parsed).toISOString();
  }
  throw new Error('One-shot schedule must include a full date and time (for example: once 2026-05-20T09:30:00Z).');
}

function normalizeIntervalUnit(unitMinutes: number, amount: number): string {
  if (unitMinutes === 1) {
    return `minute${amount === 1 ? '' : 's'}`;
  }
  if (unitMinutes === 60) {
    return `hour${amount === 1 ? '' : 's'}`;
  }
  return `day${amount === 1 ? '' : 's'}`;
}

function parseNaturalLanguageIntervalSchedule(normalizedInput: string): ParsedPackageSchedule | null {
  if (normalizedInput === 'hourly') {
    return {
      cadenceMinutes: 60,
      normalized: 'every 1 hour',
      meta: { kind: 'interval', intervalMinutes: 60 }
    };
  }
  if (normalizedInput === 'daily') {
    return {
      cadenceMinutes: 1440,
      normalized: 'every 1 day',
      meta: { kind: 'interval', intervalMinutes: 1440 }
    };
  }
  const intervalMatch = normalizedInput.match(/^every (?:(\d+) )?(minute|minutes|min|mins|hour|hours|day|days)$/);
  const repeatMatch = normalizedInput.match(/^repeat every (?:(\d+) )?(minute|minutes|min|mins|hour|hours|day|days)$/);
  const match = intervalMatch ?? repeatMatch;
  if (!match) {
    return null;
  }
  const amount = parsePositiveInt(match[1] ?? '1', 'Schedule interval');
  const unit = match[2];
  const unitMinutes = UNIT_TO_MINUTES[unit];
  if (!unitMinutes) {
    throw new Error('Schedule interval must be a positive number.');
  }
  const cadenceMinutes = amount * unitMinutes;
  return {
    cadenceMinutes,
    normalized: `every ${amount} ${normalizeIntervalUnit(unitMinutes, amount)}`,
    meta: {
      kind: 'interval',
      intervalMinutes: cadenceMinutes
    }
  };
}

function normalizeCronValue(raw: string, aliases: Record<string, number>): number {
  const value = raw.trim().toLowerCase();
  if (value in aliases) {
    return aliases[value]!;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid cron value: ${raw}`);
  }
  return parsed;
}

function addRangeValues(input: {
  output: Set<number>;
  token: string;
  min: number;
  max: number;
  aliases?: Record<string, number>;
  normalize?: (value: number) => number;
  allowSingleStepStart?: boolean;
}): void {
  const [base, stepRaw] = input.token.split('/');
  const step = stepRaw ? parsePositiveInt(stepRaw, 'Cron step') : 1;
  if (!base || step < 1) {
    throw new Error(`Invalid cron token: ${input.token}`);
  }
  const applyNormalize = (value: number): number => (input.normalize ? input.normalize(value) : value);
  const parseValue = (value: string): number =>
    normalizeCronValue(value, input.aliases ?? {});

  let start = input.min;
  let end = input.max;
  if (base !== '*') {
    if (base.includes('-')) {
      const [rawStart, rawEnd] = base.split('-');
      if (!rawStart || !rawEnd) {
        throw new Error(`Invalid cron range: ${input.token}`);
      }
      start = parseValue(rawStart);
      end = parseValue(rawEnd);
    } else {
      start = parseValue(base);
      end = input.allowSingleStepStart && stepRaw ? input.max : start;
    }
  }
  if (start < input.min || start > input.max || end < input.min || end > input.max || end < start) {
    throw new Error(`Cron value out of range: ${input.token}`);
  }
  for (let value = start; value <= end; value += step) {
    input.output.add(applyNormalize(value));
  }
}

function parseCronField(input: {
  token: string;
  min: number;
  max: number;
  aliases?: Record<string, number>;
  normalize?: (value: number) => number;
  allowSingleStepStart?: boolean;
}): { values: Set<number>; any: boolean } {
  const trimmed = input.token.trim();
  if (!trimmed) {
    throw new Error('Cron fields must not be empty.');
  }
  const values = new Set<number>();
  const segments = trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Cron fields must not be empty.');
  }
  for (const segment of segments) {
    addRangeValues({
      output: values,
      token: segment,
      min: input.min,
      max: input.max,
      aliases: input.aliases,
      normalize: input.normalize,
      allowSingleStepStart: input.allowSingleStepStart
    });
  }
  return { values, any: segments.length === 1 && segments[0] === '*' };
}

function parseCronExpression(expression: string): CronSchedule {
  const tokens = expression.trim().split(/\s+/u);
  if (tokens.length !== 5) {
    throw new Error('Cron schedules must include exactly 5 fields: minute hour day-of-month month day-of-week.');
  }
  const minute = parseCronField({ token: tokens[0], min: 0, max: 59 });
  const hour = parseCronField({ token: tokens[1], min: 0, max: 23 });
  const dayOfMonth = parseCronField({ token: tokens[2], min: 1, max: 31 });
  const month = parseCronField({ token: tokens[3], min: 1, max: 12, aliases: MONTH_ALIASES });
  const dayOfWeek = parseCronField({
    token: tokens[4],
    min: 0,
    max: 7,
    aliases: DOW_ALIASES,
    normalize: (value) => (value === 7 ? 0 : value),
    allowSingleStepStart: true
  });
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    anyDayOfMonth: dayOfMonth.any,
    anyDayOfWeek: dayOfWeek.any,
    expression: tokens.join(' ')
  };
}

function looksLikeCronExpression(input: string): boolean {
  return input.trim().split(/\s+/u).length === 5;
}

function parseCronSchedule(rawInput: string): ParsedPackageSchedule | null {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }
  const expression = trimmed.toLowerCase().startsWith('cron ') ? trimmed.slice(5) : looksLikeCronExpression(trimmed) ? trimmed : null;
  if (!expression) {
    return null;
  }
  const parsed = parseCronExpression(expression);
  return {
    cadenceMinutes: 0,
    normalized: `cron ${parsed.expression}`,
    meta: {
      kind: 'cron',
      cronExpression: parsed.expression
    }
  };
}

function parseOneShotSchedule(rawInput: string): ParsedPackageSchedule | null {
  const trimmed = rawInput.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('once ') && !lower.startsWith('at ')) {
    return null;
  }
  const timestampRaw = trimmed.slice(lower.startsWith('once ') ? 5 : 3);
  const runAt = parseAbsoluteTimestamp(timestampRaw);
  return {
    cadenceMinutes: 0,
    normalized: `once ${runAt}`,
    meta: {
      kind: 'once',
      runAt
    }
  };
}

function cronMatches(cron: CronSchedule, value: Date): boolean {
  if (!cron.minute.has(value.getMinutes())) {
    return false;
  }
  if (!cron.hour.has(value.getHours())) {
    return false;
  }
  if (!cron.month.has(value.getMonth() + 1)) {
    return false;
  }
  const domMatch = cron.dayOfMonth.has(value.getDate());
  const dowMatch = cron.dayOfWeek.has(value.getDay());
  if (cron.anyDayOfMonth && cron.anyDayOfWeek) {
    return true;
  }
  if (cron.anyDayOfMonth) {
    return dowMatch;
  }
  if (cron.anyDayOfWeek) {
    return domMatch;
  }
  return domMatch || dowMatch;
}

function computeCronRunAtOrAfter(input: { expression: string; anchorIso: string; referenceIso: string }): string | null {
  const cron = parseCronExpression(input.expression);
  const anchorMs = Date.parse(input.anchorIso);
  const referenceMs = Date.parse(input.referenceIso);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(referenceMs)) {
    throw new Error('Package job schedule timestamps must be valid ISO values.');
  }
  let candidateMs = Math.max(anchorMs, referenceMs);
  candidateMs = Math.floor(candidateMs / 60_000) * 60_000;
  if (candidateMs < Math.max(anchorMs, referenceMs)) {
    candidateMs += 60_000;
  }
  const maxIterations = 5 * 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i += 1) {
    const candidate = new Date(candidateMs);
    if (cronMatches(cron, candidate)) {
      return candidate.toISOString();
    }
    candidateMs += 60_000;
  }
  return null;
}

function isPackageScheduleMeta(value: unknown): value is PackageScheduleMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'interval') {
    return Number.isFinite((value as { intervalMinutes?: unknown }).intervalMinutes);
  }
  if (kind === 'cron') {
    return typeof (value as { cronExpression?: unknown }).cronExpression === 'string';
  }
  if (kind === 'once') {
    return typeof (value as { runAt?: unknown }).runAt === 'string';
  }
  return false;
}

export function parsePackageScheduleMeta(input: string | null | undefined): PackageScheduleMeta | null {
  if (!input || !input.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(input) as unknown;
    return isPackageScheduleMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function packageScheduleMetaToJson(meta: PackageScheduleMeta): string {
  return JSON.stringify(meta);
}

export function parsePackageSchedule(input: string): ParsedPackageSchedule {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new Error('Schedule is required.');
  }
  const oneShot = parseOneShotSchedule(input);
  if (oneShot) {
    return oneShot;
  }
  const cron = parseCronSchedule(input);
  if (cron) {
    return cron;
  }
  const interval = parseNaturalLanguageIntervalSchedule(normalized);
  if (interval) {
    return interval;
  }
  throw new Error(
    'Unsupported schedule. Use interval schedules ("every 2 hours", "daily"), cron (<m h dom mon dow>), or one-shot ("once 2026-05-20T09:30:00Z").'
  );
}

export function parsePackageScheduleStartTime(input: string | undefined, nowIso: string): string {
  if (!input || input.trim() === '') {
    return nowIso;
  }

  const trimmed = input.trim();
  const timeOnly = parseTimeOfDay(trimmed, nowIso);
  if (timeOnly) {
    return timeOnly;
  }

  const localDateTime = parseLocalDateTime(trimmed);
  if (localDateTime) {
    return localDateTime;
  }

  if (hasExplicitTimezone(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  throw new Error(
    'Unsupported start_time. Use HH:MM, HH:MM:SS, YYYY-MM-DD HH:MM, YYYY-MM-DDTHH:MM, or an ISO timestamp with timezone.'
  );
}

function computePackageJobRunAtOrAfter(anchorIso: string, cadenceMinutes: number, referenceIso: string): string {
  const anchorMs = Date.parse(anchorIso);
  const referenceMs = Date.parse(referenceIso);
  if (Number.isNaN(anchorMs) || Number.isNaN(referenceMs)) {
    throw new Error('Package job schedule timestamps must be valid ISO values.');
  }
  if (referenceMs <= anchorMs) {
    return new Date(anchorMs).toISOString();
  }

  const cadenceMs = cadenceMinutes * 60_000;
  const elapsedMs = referenceMs - anchorMs;
  const intervals = Math.ceil(elapsedMs / cadenceMs);
  return new Date(anchorMs + intervals * cadenceMs).toISOString();
}

export function computePackageJobRunAtOrAfterWithMeta(
  anchorIso: string,
  cadenceMinutes: number,
  referenceIso: string,
  meta: PackageScheduleMeta | null
): string | null {
  if (!meta || meta.kind === 'interval') {
    if (cadenceMinutes <= 0) {
      return null;
    }
    return computePackageJobRunAtOrAfter(anchorIso, cadenceMinutes, referenceIso);
  }
  if (meta.kind === 'once') {
    const runAtMs = Date.parse(meta.runAt);
    const referenceMs = Date.parse(referenceIso);
    if (!Number.isFinite(runAtMs) || !Number.isFinite(referenceMs)) {
      throw new Error('Package job schedule timestamps must be valid ISO values.');
    }
    return runAtMs >= referenceMs ? new Date(runAtMs).toISOString() : null;
  }
  return computeCronRunAtOrAfter({
    expression: meta.cronExpression,
    anchorIso,
    referenceIso
  });
}

export function computeNextPackageJobRunAtWithMeta(
  anchorIso: string,
  cadenceMinutes: number,
  afterIso: string,
  meta: PackageScheduleMeta | null
): string | null {
  if (meta?.kind === 'once') {
    return null;
  }
  return computePackageJobRunAtOrAfterWithMeta(
    anchorIso,
    cadenceMinutes,
    new Date(Date.parse(afterIso) + 1).toISOString(),
    meta
  );
}

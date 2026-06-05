import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skill';
}

function safeRelativePath(value: string): string {
  const normalized = normalize(value).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
  if (!normalized || normalized === '.' || normalized.endsWith('..')) {
    throw new Error(`Invalid skill resource path: ${value}`);
  }
  if (normalized === 'moorline' || normalized.startsWith(`moorline/`) || normalized.startsWith(`moorline\\`)) {
    throw new Error('Generated skills cannot write into skills/moorline');
  }
  return normalized;
}

interface SkillResourceFileInput {
  path: string;
  content: string;
}

interface WriteSkillInput {
  rootDir: string;
  name: string;
  description?: string;
  tags?: string[];
  body: string;
  directoryName?: string;
  resourceFiles?: SkillResourceFileInput[];
}

interface WrittenSkillResult {
  skillDir: string;
  skillPath: string;
  resourcePaths: string[];
}

function parseScalar(raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value.replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(body: string): { metadata: Record<string, string | string[]>; content: string; hasFrontmatter: boolean } {
  if (!body.startsWith('---\n')) {
    return {
      metadata: {},
      content: body,
      hasFrontmatter: false
    };
  }

  const end = body.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error('Malformed SKILL.md frontmatter: missing closing delimiter.');
  }

  const frontmatter = body.slice(4, end).split('\n');
  const metadata: Record<string, string | string[]> = {};
  let pendingListKey: string | null = null;

  for (const line of frontmatter) {
    if (/^\s*-\s+/.test(line) && pendingListKey) {
      const next = line.replace(/^\s*-\s+/, '').trim();
      const current = metadata[pendingListKey];
      const values = Array.isArray(current) ? current : [];
      values.push(next);
      metadata[pendingListKey] = values;
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      pendingListKey = null;
      continue;
    }

    const [, key, rawValue] = match;
    if (!rawValue.trim()) {
      metadata[key] = [];
      pendingListKey = key;
      continue;
    }

    metadata[key] = parseScalar(rawValue);
    pendingListKey = null;
  }

  return {
    metadata,
    content: body.slice(end + 5).trim(),
    hasFrontmatter: true
  };
}

function asString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

function stringifyFrontmatterValue(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value.length > 0 ? [`[${value.join(', ')}]`] : ['[]'];
  }
  return [value];
}

function buildSkillDocument(input: WriteSkillInput): string {
  const parsed = parseFrontmatter(input.body.trim());
  const metadata: Record<string, string | string[]> = {
    ...parsed.metadata
  };

  metadata.name = input.name.trim() || asString(metadata.name) || '';
  if (typeof input.description === 'string' && input.description.trim()) {
    metadata.description = input.description.trim();
  }
  if (Array.isArray(input.tags) && input.tags.length > 0) {
    metadata.tags = input.tags.map((tag) => tag.trim()).filter(Boolean);
  }

  const name = asString(metadata.name);
  const description = asString(metadata.description);
  if (!name) {
    throw new Error('Skill frontmatter must include a non-empty name.');
  }
  if (!description) {
    throw new Error('Skill frontmatter must include a non-empty description.');
  }

  const orderedKeys = ['name', 'description', 'tags'];
  const extraKeys = Object.keys(metadata).filter((key) => !orderedKeys.includes(key)).sort();
  const frontmatterLines = [...orderedKeys, ...extraKeys]
    .filter((key) => metadata[key] !== undefined)
    .flatMap((key) => stringifyFrontmatterValue(metadata[key]!).map((value) => `${key}: ${value}`));

  const content = parsed.content.trim();
  return ['---', ...frontmatterLines, '---', '', content].join('\n').trimEnd();
}

function verifySkillDocument(body: string): void {
  const { metadata, hasFrontmatter } = parseFrontmatter(body);
  if (!hasFrontmatter) {
    throw new Error('Saved SKILL.md is missing YAML frontmatter.');
  }
  if (!asString(metadata.name)) {
    throw new Error('Saved SKILL.md is missing frontmatter field: name.');
  }
  if (!asString(metadata.description)) {
    throw new Error('Saved SKILL.md is missing frontmatter field: description.');
  }
}

export function writeSkill(input: WriteSkillInput): WrittenSkillResult {
  const directoryName = input.directoryName ? safeRelativePath(input.directoryName) : slugify(input.name);
  const skillDir = join(input.rootDir, directoryName);
  const skillPath = join(skillDir, 'SKILL.md');
  const skillDocument = buildSkillDocument(input);
  verifySkillDocument(skillDocument);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, `${skillDocument}\n`, 'utf8');

  const resourcePaths: string[] = [];
  for (const resource of input.resourceFiles ?? []) {
    const relativePath = safeRelativePath(resource.path);
    const absolutePath = join(skillDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, resource.content, 'utf8');
    resourcePaths.push(relativePath);
  }

  return {
    skillDir,
    skillPath,
    resourcePaths
  };
}

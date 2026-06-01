import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

interface SkillCatalogEntry {
  name: string;
  description: string;
  path: string;
  tags: string[];
  metadata: Record<string, string | string[]>;
}

interface LoadedSkill extends SkillCatalogEntry {
  content: string;
  resourcePaths: string[];
}

interface SkillRecord extends LoadedSkill {
  aliases: string[];
}

interface SkillFileRecord {
  path: string;
  mtimeMs: number;
  size: number;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

function parseFrontmatter(body: string): { metadata: Record<string, string | string[]>; content: string } {
  if (!body.startsWith('---\n')) {
    return {
      metadata: {},
      content: body
    };
  }

  const end = body.indexOf('\n---\n', 4);
  if (end === -1) {
    return {
      metadata: {},
      content: body
    };
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
    content: body.slice(end + 5).trim()
  };
}

function walkSkillFiles(rootDir: string): SkillFileRecord[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const stack = [rootDir];
  const files: SkillFileRecord[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      const stat = statSync(fullPath, { throwIfNoEntry: false });
      if (!stat) {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (stat.isFile() && entry === 'SKILL.md') {
        files.push({
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size
        });
      }
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function collectResources(skillPath: string): string[] {
  const skillDir = dirname(skillPath);
  const stack = [skillDir];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      const stat = statSync(fullPath, { throwIfNoEntry: false });
      if (!stat) {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (stat.isFile() && entry !== 'SKILL.md') {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function asString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

function asArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export class SkillRegistry {
  private cache:
    | {
        token: string;
        records: SkillRecord[];
      }
    | null = null;

  constructor(private readonly roots: string[]) {}

  invalidateCache(): void {
    this.cache = null;
  }

  list(): SkillCatalogEntry[] {
    return this.scan().map(({ name, description, path, tags, metadata }) => ({
      name,
      description,
      path,
      tags,
      metadata
    }));
  }

  load(name: string): LoadedSkill | null {
    const records = this.scan();
    const byAlias = new Map(
      records.flatMap((record) => record.aliases.map((alias) => [alias, record] as const))
    );
    const record = byAlias.get(slugify(name)) ?? byAlias.get(name.trim().toLowerCase());
    if (!record) {
      return null;
    }
    return {
      name: record.name,
      description: record.description,
      path: record.path,
      tags: record.tags,
      metadata: record.metadata,
      content: record.content,
      resourcePaths: record.resourcePaths
    };
  }

  private cacheToken(): string {
    const parts: string[] = [];
    for (const root of this.roots) {
      const files = walkSkillFiles(root);
      parts.push(root);
      for (const file of files) {
        parts.push(`${file.path}:${file.mtimeMs}:${file.size}`);
      }
    }
    return parts.join('|');
  }

  private scan(): SkillRecord[] {
    const token = this.cacheToken();
    if (this.cache && this.cache.token === token) {
      return this.cache.records;
    }

    const seen = new Set<string>();
    const records: SkillRecord[] = [];

    for (const root of this.roots) {
      for (const skillFile of walkSkillFiles(root)) {
        const skillPath = skillFile.path;
        const body = readFileSync(skillPath, 'utf8');
        const { metadata } = parseFrontmatter(body);
        const name =
          asString(metadata.name) ??
          basename(dirname(skillPath));
        const description =
          asString(metadata.description) ??
          asString(metadata.summary) ??
          'No description provided.';
        const tags = asArray(metadata.tags);
        const aliases = new Set<string>([
          slugify(name),
          name.trim().toLowerCase(),
          slugify(basename(dirname(skillPath)))
        ]);

        const key = `${slugify(name)}:${skillPath}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        records.push({
          name,
          description,
          path: skillPath,
          tags,
          metadata,
          content: body.trim(),
          resourcePaths: collectResources(skillPath).map((resourcePath) => relative(dirname(skillPath), resourcePath) || resourcePath),
          aliases: Array.from(aliases)
        });
      }
    }

    const sorted = records.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = {
      token,
      records: sorted
    };
    return sorted;
  }
}

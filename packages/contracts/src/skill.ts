import type { JsonSchemaLike, PackageDependency, PackageManifestBase } from './package.js';
import { validateJsonSchemaLike, validatePackageActivationRule, validatePackageDependencies, validatePackageId } from './package.js';

export interface SkillPackageManifest extends PackageManifestBase {
  type: 'skill';
  skillsRoot?: string;
  dependencies?: PackageDependency[];
  configSchema?: JsonSchemaLike;
}

export function validateSkillPackageManifest(manifest: SkillPackageManifest): SkillPackageManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Skill package manifest must be an object');
  }
  const record = manifest as unknown as Record<string, unknown>;
  validatePackageId(record.id, 'Skill package manifest id');
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new Error('Skill package manifest name is required');
  }
  if (typeof record.version !== 'string' || !record.version.trim()) {
    throw new Error('Skill package manifest version is required');
  }
  if (record.type !== 'skill') {
    throw new Error('Skill package manifest type must be "skill"');
  }
  if (record.description !== undefined && (typeof record.description !== 'string' || !record.description.trim())) {
    throw new Error('Skill package manifest description must be non-empty when provided');
  }
  if (record.skillsRoot !== undefined && (typeof record.skillsRoot !== 'string' || !record.skillsRoot.trim())) {
    throw new Error('Skill package manifest skillsRoot must be non-empty when provided');
  }
  validatePackageDependencies(record.dependencies, 'skill manifest');
  validateJsonSchemaLike(record.configSchema, 'skill manifest');
  const activation = validatePackageActivationRule(record.activation, 'skill manifest');
  return {
    ...manifest,
    ...(activation !== undefined ? { activation } : {})
  };
}

export interface MoorlineDistroMetadata {
  schemaVersion: 1;
  name?: string;
  description?: string;
  version?: string;
  display?: {
    name?: string;
    description?: string;
    version?: string;
    category?: string;
    tags?: string[];
    publisher?: string;
    license?: string;
    homepageUrl?: string;
    docsUrl?: string;
    iconPath?: string;
    hidden?: boolean;
    experimental?: boolean;
  };
  distribution?: {
    audiences?: Array<'setup' | 'advanced' | 'internal'>;
    setupOrder?: number;
  };
  compatibility?: {
    moorline?: string;
    platforms?: string[];
  };
  release?: {
    recommendedRef?: string;
    channel?: 'stable' | 'preview' | 'experimental';
  };
}

export interface ResolvedMoorlineDistroMetadata extends MoorlineDistroMetadata {
  display: NonNullable<MoorlineDistroMetadata['display']> & {
    name: string;
    description: string;
    version: string;
  };
}

export function validateMoorlineDistroMetadata(
  distro: MoorlineDistroMetadata,
  label = 'moorline.dist.json'
): MoorlineDistroMetadata {
  if (!distro || typeof distro !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  if (distro.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion must be 1`);
  }
  const name = distro.display?.name ?? distro.name;
  const description = distro.display?.description ?? distro.description;
  const version = distro.display?.version ?? distro.version;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${label}.name is required`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`${label}.description is required`);
  }
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error(`${label}.version is required`);
  }
  if (distro.compatibility?.moorline !== undefined && typeof distro.compatibility.moorline !== 'string') {
    throw new Error(`${label}.compatibility.moorline must be a string when provided`);
  }
  if (
    distro.compatibility?.platforms !== undefined &&
    (!Array.isArray(distro.compatibility.platforms) || distro.compatibility.platforms.some((entry) => typeof entry !== 'string' || !entry.trim()))
  ) {
    throw new Error(`${label}.compatibility.platforms must be a string array when provided`);
  }
  return distro;
}

export type MoorlineRuntimeMode = 'source_checkout' | 'packaged_release';

export interface MoorlineReleaseManifest {
  version: string;
  gitCommit: string | null;
  builtAt: string;
  platform: string;
  arch: string;
  runtimeMode: MoorlineRuntimeMode;
  resourcesVersion: number;
}

export interface RuntimePackageLoadFailure {
  surface: 'provider' | 'transport' | 'plugin';
  packageId: string;
  phase: 'startup' | 'runtime_reload';
  detail: string;
  recordedAt: string;
  required: boolean;
}

export interface RuntimePackageLoadReport {
  runtimeMode: MoorlineRuntimeMode;
  releaseManifest: MoorlineReleaseManifest;
  failures: RuntimePackageLoadFailure[];
  updatedAt: string;
}

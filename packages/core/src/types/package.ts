export {
  packageFamilyForKind,
  packageFamilyForSurface,
  validatePackageActivationRule,
  validatePackageBundleMembers,
  validateJsonSchemaLike,
  validatePackageDependencies,
  validatePackageId,
  type BundleMemberActivation,
  type JsonSchemaLike,
  type PackageActivationRule,
  type PackageBundleMember,
  type PackageDependency,
  type PackageFamily,
  type PackageKind,
  type PackageManifestBase,
  type PackageRef,
  type PackageRuntimeKind,
  type PackageRuntimeState,
  type PackageSourceDescriptor,
  type PackageSourceProvenance,
  type PackageSurface
} from '@moorline/contracts';

import type {
  PackageActivationRule,
  PackageBundleMember,
  PackageDependency,
  PackageFamily,
  PackageKind,
  PackageRef,
  PackageRuntimeKind,
  PackageSourceDescriptor,
  PackageSurface
} from '@moorline/contracts';

export interface PackageInstallRecord {
  family: PackageFamily;
  kind: PackageKind;
  /** Route/API field; mirrors kind until external route terminology is fully unified. */
  surface: PackageKind;
  packageId: string;
  name: string;
  version: string;
  description?: string;
  installedAt: string;
  installPath: string;
  source: PackageSourceDescriptor;
  manifestPath: string;
  manifestHash: string;
  dependencies: PackageDependency[];
  activation?: PackageActivationRule;
  members?: PackageBundleMember[];
  installedByPackageIds?: string[];
  activatedByPackageIds?: string[];
}

export interface PackageMetadataEntry {
  kind: PackageKind;
  /** Route/API field; mirrors kind until external route terminology is fully unified. */
  surface: PackageKind;
  packageId: string;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  source: PackageSourceDescriptor;
  requires: string[];
  members?: PackageBundleMember[];
  suggestedAfterInstall?: string[];
}

export interface PackageDesiredState {
  activated: PackageRef[];
  transportActivePackageId?: string | null;
  providerActivePackageId?: string | null;
  enabledPluginPackageIds?: string[];
  enabledSkillPackageIds?: string[];
}

export type PackageAppliedState = PackageDesiredState;

export interface PackageResolutionError {
  code:
    | 'missing_dependency'
    | 'inactive_dependency'
    | 'dependency_cycle'
    | 'unknown_package'
    | 'dependent_packages_present'
    | 'invalid_manifest';
  kind: PackageRuntimeKind;
  surface: PackageSurface;
  packageId: string;
  detail: string;
  dependency?: PackageDependency;
  dependentPackageIds?: string[];
}

export interface PackageApplyPlan {
  desired: PackageDesiredState;
  applied: PackageAppliedState;
  pending: boolean;
  actions: string[];
  reloadLevel: 'none' | 'plugin_only' | 'runtime_reload' | 'full_restart';
  errors: PackageResolutionError[];
}

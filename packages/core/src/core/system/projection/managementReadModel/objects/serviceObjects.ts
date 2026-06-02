import { join } from 'node:path';
import type { ManagedServiceRecord } from '../../../../../types/app.js';
import type { PackageInstallRecord } from '../../../../../types/package.js';
import type { ManagementReadModelServiceDeps } from '../deps.js';
import { managedTrustForPackage } from '../packageTrust.js';

function selectedPackageName(deps: ManagementReadModelServiceDeps, surface: 'transport' | 'provider', fallback: string): string {
  const packageId = deps.config.surfaces[surface].activePackageId;
  return packageId ?? fallback;
}

function selectedPackageId(deps: ManagementReadModelServiceDeps, surface: 'transport' | 'provider'): string {
  return deps.config.surfaces[surface].activePackageId ?? deps.config[surface]?.packageId ?? deps.config[surface]?.kind ?? 'unselected';
}

function installedPackage(
  installed: PackageInstallRecord[],
  surface: 'transport' | 'provider',
  packageId: string
): PackageInstallRecord | null {
  return installed.find((entry) => entry.kind === surface && entry.packageId === packageId) ?? null;
}

export function buildServiceObjects(deps: ManagementReadModelServiceDeps, installed: PackageInstallRecord[]): ManagedServiceRecord[] {
  const managementSurface = deps.getManagementSurface();
  const providerDiagnostics = deps.provider.getDiagnostics();
  const runtimeStatus = deps.getRuntimeStatus();
  const runtimeControl = deps.getRuntimeControlStatus();
  const transportPackageId = selectedPackageId(deps, 'transport');
  const providerPackageId = selectedPackageId(deps, 'provider');
  const transportPackage = installedPackage(installed, 'transport', transportPackageId);
  const providerPackage = installedPackage(installed, 'provider', providerPackageId);

  return [
    {
      id: 'runtime-core',
      kind: 'service',
      name: 'Runtime Core',
      summary: 'Supervision, policy, audit, orchestration, and recovery.',
      controls: ['reload', 'accepting_new_work'],
      mutability: { editable: false, installable: false, removable: false },
      trust: { level: 'official', source: 'core runtime' },
      sourceOfTruth: { kind: 'runtime', label: 'MoorlineRuntime' },
      runtimeState: {
        status: runtimeControl.acceptingNewWork ? 'accepting' : 'draining',
        updatedAt: deps.now(),
        details: runtimeStatus
      },
      serviceType: 'runtime'
    },
    {
      id: `transport-${transportPackageId}`,
      kind: 'service',
      name: selectedPackageName(deps, 'transport', 'Transport Surface'),
      summary: 'Selected transport surface and surface host.',
      controls: ['inspect'],
      mutability: { editable: false, installable: false, removable: false },
      trust: managedTrustForPackage(transportPackage, transportPackageId),
      sourceOfTruth: { kind: 'transport', label: 'selected transport config' },
      runtimeState: {
        status: deps.getSurfaceState() ? 'running' : 'not_bootstrapped',
        updatedAt: deps.now(),
        details: {
          scopeId: deps.config.transport?.scopeId ?? deps.config.surfaces.transport.activePackageId ?? '',
          transportApplicationId: deps.config.transport?.config.applicationId ?? ''
        }
      },
      serviceType: 'transport'
    },
    {
      id: `provider-${providerPackageId}`,
      kind: 'service',
      name: selectedPackageName(deps, 'provider', 'Provider Runtime'),
      summary: 'Provider session lifecycle and thread execution service.',
      controls: ['provider_start_all', 'provider_stop_all'],
      mutability: { editable: false, installable: false, removable: false },
      trust: managedTrustForPackage(providerPackage, providerPackageId),
      sourceOfTruth: { kind: 'provider', label: 'selected provider runtime' },
      runtimeState: {
        status: providerDiagnostics.connectedSessions > 0 ? 'connected' : 'idle',
        updatedAt: deps.now(),
        details: providerDiagnostics as unknown as Record<string, unknown>
      },
      serviceType: 'provider'
    },
    {
      id: 'control-api',
      kind: 'service',
      name: 'Control API',
      summary: 'Canonical control-plane process for CLI and remote API clients.',
      controls: ['inspect'],
      mutability: { editable: false, installable: false, removable: false },
      trust: { level: 'official', source: 'control api host' },
      sourceOfTruth: { kind: 'runtime', label: 'control api host' },
      runtimeState: {
        status: managementSurface.enabled ? 'running' : 'disabled',
        updatedAt: deps.now(),
        details: {
          host: managementSurface.host,
          port: managementSurface.port,
          url: managementSurface.url,
          authMode: 'bearer-token'
        }
      },
      serviceType: 'management'
    },
    {
      id: 'sqlite-state',
      kind: 'service',
      name: 'SQLite State',
      summary: 'Durable runtime state and projections.',
      controls: ['inspect'],
      mutability: { editable: false, installable: false, removable: false },
      trust: { level: 'official', source: 'managed runtime state' },
      sourceOfTruth: {
        kind: 'filesystem',
        label: 'state.db',
        path: join(deps.runtimeRoot, 'state.db')
      },
      runtimeState: {
        status: 'ready',
        updatedAt: deps.now()
      },
      serviceType: 'storage'
    },
    {
      id: 'policy-audit',
      kind: 'service',
      name: 'Policy Audit Log',
      summary: 'Audit trail for guarded actions and control changes.',
      controls: ['inspect'],
      mutability: { editable: false, installable: false, removable: false },
      trust: { level: 'official', source: 'managed runtime logs' },
      sourceOfTruth: {
        kind: 'filesystem',
        label: 'policy-audit.jsonl',
        path: join(deps.runtimeRoot, 'logs', 'policy-audit.jsonl')
      },
      runtimeState: {
        status: 'ready',
        updatedAt: deps.now()
      },
      serviceType: 'audit'
    }
  ];
}

import { defaultAdminConfig, type AppliedMoorlineConfig, type RuntimeSurfaceState } from '../../../types/config.js';
import type { RuntimeEnvironmentVerifier } from '../../../types/provider.js';
import { loadInstallationState, saveInstallationState } from '../../system/config/configStore.js';
import type { RuntimeManagementSurfaceHandle } from './runtimeManagementPort.js';
import type {
  RuntimeActionDefinition,
  RuntimeTransport,
  RuntimeTransportEvent
} from '../../../types/transport.js';

interface RuntimeHostingServiceDeps {
  config: AppliedMoorlineConfig;
  transport: RuntimeTransport;
  managementSurface: RuntimeManagementSurfaceHandle;
  installationPath: string;
  now(): string;
  verifyEnvironment?: RuntimeEnvironmentVerifier;
  authorizeTransportSetup<T>(input: { target: string; execute: () => Promise<T> }): Promise<T>;
}

interface RuntimeHostingHandlers {
  actions: RuntimeActionDefinition[];
  onTransportEvent(event: RuntimeTransportEvent): Promise<void>;
}

export class RuntimeHostingService {
  private startupFailure: string | null = null;

  constructor(private readonly deps: RuntimeHostingServiceDeps) {}

  async start(handlers: RuntimeHostingHandlers): Promise<RuntimeSurfaceState> {
    this.startupFailure = null;
    const rollbackSteps: Array<() => Promise<void>> = [];
    try {
      await this.assertEnvironment();
      const transportConfig = this.deps.config.transport.config;
      await this.deps.transport.start({
        token: typeof transportConfig.authToken === 'string' ? transportConfig.authToken : undefined,
        metadata: transportConfig
      });
      rollbackSteps.push(async () => {
        await this.deps.transport.stop();
      });
      const namespaceState = await this.bootstrapNamespace();
      await this.deps.managementSurface.start();
      rollbackSteps.push(async () => {
        await this.deps.managementSurface.stop();
      });
      if (this.deps.transport.capabilities().nativeActions && this.deps.transport.registerNativeActions) {
        await this.deps.authorizeTransportSetup({
          target: this.deps.config.transport.scopeId ?? this.deps.config.transport.packageId,
          execute: async () =>
            await this.deps.transport.registerNativeActions?.({
              scopeId: this.deps.config.transport.scopeId ?? '',
              actions: handlers.actions
            })
        });
      }
      this.deps.transport.onEvent(async (event) => {
        await handlers.onTransportEvent(event);
      });
      return namespaceState;
    } catch (error) {
      this.startupFailure = error instanceof Error ? error.message : String(error);
      await this.rollbackStartup(rollbackSteps);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.deps.managementSurface.stop();
    await this.deps.transport.stop();
  }

  getStartupFailure(): string | null {
    return this.startupFailure;
  }

  private async rollbackStartup(steps: Array<() => Promise<void>>): Promise<void> {
    for (const step of [...steps].reverse()) {
      try {
        await step();
      } catch {
        // Rollback continues to best-effort cleanup for already-started resources.
      }
    }
  }

  private async assertEnvironment(): Promise<void> {
    if (this.deps.verifyEnvironment) {
      await this.deps.verifyEnvironment();
    }
    const verification = await this.deps.transport.verifyAccess({
      authToken: typeof this.deps.config.transport.config.authToken === 'string' ? this.deps.config.transport.config.authToken : undefined,
      scopeId: this.deps.config.transport.scopeId ?? '',
      applicationId: typeof this.deps.config.transport.config.applicationId === 'string' ? this.deps.config.transport.config.applicationId : undefined
    });
    const expectedApplicationId = typeof this.deps.config.transport.config.applicationId === 'string' ? this.deps.config.transport.config.applicationId : null;
    if (expectedApplicationId && verification.applicationId !== expectedApplicationId) {
      throw new Error('Transport application id does not match the saved Moorline config');
    }
  }

  private async bootstrapNamespace(): Promise<RuntimeSurfaceState> {
    const existing = loadInstallationState(this.deps.installationPath);
    const transportConfig = this.deps.config.transport.config;
    if (this.deps.transport.reconcileRuntimeSurface) {
      const adminConfig = this.deps.config.admin ?? defaultAdminConfig();
      const reconciled = await this.deps.authorizeTransportSetup({
        target: this.deps.config.transport.scopeId ?? this.deps.config.transport.packageId ?? 'transport',
        execute: async () =>
          await this.deps.transport.reconcileRuntimeSurface!({
            scopeId: this.deps.config.transport.scopeId,
            actorId: typeof transportConfig.actorId === 'string' ? transportConfig.actorId : undefined,
            names: this.deps.config.surface,
            managedAdminAccessGroup: adminConfig.managedRole,
            managedMemberAccessGroup: adminConfig.managedUserRole,
            explicitAdminRoleIds: adminConfig.accessGroupIds,
            explicitAdminUserIds: adminConfig.userIds,
            previousState: existing,
            nowIso: this.deps.now(),
            config: transportConfig
          })
      });
      saveInstallationState(this.deps.installationPath, reconciled);
      return reconciled;
    }

    if (existing && (!this.deps.config.transport.scopeId || existing.scopeId === this.deps.config.transport.scopeId)) {
      return existing;
    }

    const nowIso = this.deps.now();
    const defaultState: RuntimeSurfaceState = {
      scopeId: this.deps.config.transport.scopeId,
      mainCategoryId: this.deps.config.surface.mainCategoryName,
      chatChannelId: this.deps.config.surface.chatChannelName,
      statusChannelId: this.deps.config.surface.statusChannelName,
      sessionsCategoryId: this.deps.config.surface.sessionsGroupName,
      missionsCategoryId: this.deps.config.surface.missionsGroupName,
      archiveCategoryId: this.deps.config.surface.archiveGroupName,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    saveInstallationState(this.deps.installationPath, defaultState);
    return defaultState;
  }

}

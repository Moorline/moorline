import type { AppliedMoorlineConfig, RuntimeSurfaceState } from '../../../types/config.js';
import type { RuntimeEnvironmentVerifier } from '../../../types/provider.js';
import { loadInstallationState, saveInstallationState } from '../../system/config/configStore.js';
import type { RuntimeManagementSurfaceHandle } from './runtimeManagementPort.js';
import type { RuntimeActionDefinition, RuntimeTransport, RuntimeTransportIntent } from '../../../types/transport.js';
import type { RuntimeTransportEffectService } from './runtimeTransportEffectService.js';

interface RuntimeHostingServiceDeps {
  config: AppliedMoorlineConfig;
  transport: RuntimeTransport;
  effects: RuntimeTransportEffectService;
  managementSurface: RuntimeManagementSurfaceHandle;
  installationPath: string;
  now(): string;
  verifyEnvironment?: RuntimeEnvironmentVerifier;
  authorizeTransportSetup<T>(input: { target: string; execute: () => Promise<T> }): Promise<T>;
}

interface RuntimeHostingHandlers {
  actions: RuntimeActionDefinition[];
  onTransportIntent(intent: RuntimeTransportIntent): Promise<void>;
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
      const surfaceState = await this.bootstrapSurface();
      await this.deps.managementSurface.start();
      rollbackSteps.push(async () => {
        await this.deps.managementSurface.stop();
      });
      if (this.deps.transport.capabilities().nativeActions) {
        await this.deps.authorizeTransportSetup({
          target: this.deps.config.transport.scopeId ?? this.deps.config.transport.packageId,
          execute: async () =>
            await this.deps.effects.registerActions('runtime:hosting', {
              scopeId: this.deps.config.transport.scopeId ?? '',
              actions: handlers.actions
            })
        });
      }
      if (this.deps.transport.onIntent) {
        this.deps.transport.onIntent(async (intent) => {
          await handlers.onTransportIntent(intent);
        });
      } else {
        throw new Error('Transport must implement onIntent.');
      }
      return surfaceState;
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

  private async bootstrapSurface(): Promise<RuntimeSurfaceState> {
    const existing = loadInstallationState(this.deps.installationPath);
    if (existing && (!this.deps.config.transport.scopeId || existing.scopeId === this.deps.config.transport.scopeId)) {
      return existing;
    }

    const nowIso = this.deps.now();
    const defaultState: RuntimeSurfaceState = {
      scopeId: this.deps.config.transport.scopeId,
      surfaceId: this.deps.config.transport.scopeId ?? this.deps.config.transport.packageId,
      statusResourceId: this.deps.config.surface.statusResourceName,
      coordinationResourceId: this.deps.config.surface.coordinationResourceName,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    saveInstallationState(this.deps.installationPath, defaultState);
    return defaultState;
  }

}

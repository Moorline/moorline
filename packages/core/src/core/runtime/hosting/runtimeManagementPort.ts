import {
  defaultHttpApiAdapterConfig,
  type ControlApiConfig,
  type MoorlineConfig
} from '../../../types/config.js';
import type { RuntimePluginContext } from '../../../types/plugin.js';
import type { RuntimeActorIdentity } from '../../../types/transport.js';
import type { ManagementReadModelService } from '../../system/projection/managementReadModelService.js';
import type { ProviderControlResult, RuntimeControlResult, RuntimeReloadMode } from '../supervision/runtimeControl.js';

export interface RuntimeManagementSurfaceState {
  enabled: boolean;
  host: string;
  port: number;
  url: string | null;
}

export interface RuntimeManagementSurfaceHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  getUrl(): string | null;
  getAccessUrl(): string | null;
  getSurfaceState(): RuntimeManagementSurfaceState;
}

export interface RuntimeManagementSurfaceFactoryInput {
  config: MoorlineConfig;
  configPath?: string;
  managementReadModel: ManagementReadModelService;
  createPluginContext(actorId: string): RuntimePluginContext;
  requestSetRuntimeAcceptingNewWork(input: {
    actorId: string;
    accepting: boolean;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<void>;
  requestRuntimeReload(input: {
    actorId: string;
    mode: RuntimeReloadMode;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<RuntimeControlResult>;
  requestStopProviderSessions(input: {
    actorId: string;
    threadId?: string;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<ProviderControlResult>;
  requestStartProviderSessions(input: {
    actorId: string;
    threadId?: string;
    reason: string;
    requestedBy: RuntimeActorIdentity;
  }): Promise<ProviderControlResult>;
}

export interface RuntimeManagementSurfaceFactory {
  create(input: RuntimeManagementSurfaceFactoryInput): RuntimeManagementSurfaceHandle;
}

export class NoopRuntimeManagementSurface implements RuntimeManagementSurfaceHandle {
  constructor(private readonly management: ControlApiConfig = defaultHttpApiAdapterConfig()) {}

  async start(): Promise<void> {
    return undefined;
  }

  async stop(): Promise<void> {
    return undefined;
  }

  getUrl(): string | null {
    return null;
  }

  getAccessUrl(): string | null {
    return null;
  }

  getSurfaceState(): RuntimeManagementSurfaceState {
    return {
      enabled: this.management.enabled,
      host: this.management.host,
      port: this.management.port,
      url: null
    };
  }
}

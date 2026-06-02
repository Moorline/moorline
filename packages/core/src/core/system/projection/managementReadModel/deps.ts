import type { MoorlineConfig, RuntimeSurfaceState } from '../../../../types/config.js';
import type { RuntimeProvider } from '../../../../types/provider.js';
import type { SkillRegistry } from '../../../extension/skills/skillRegistry.js';
import type { RuntimeControlStatus } from '../../../runtime/supervision/runtimeControl.js';
import type { SidecarManager } from '../../../runtime/supervision/sidecarManager.js';
import type { RuntimeSnapshotQuery } from '../runtimeSnapshotQuery.js';
import type { SqliteSessionStore } from '../../state/sqliteSessionStore.js';
import type { PluginHost } from '../../../extension/plugins/pluginHost.js';
import type { RuntimePluginContext } from '../../../../types/plugin.js';
import type {
  ManagementRuntimeWorkerQueueHealthRecord,
  ManagementReadModelPresentation,
  ManagementRuntimeStatusProvider
} from '../../../../types/app.js';

export interface ManagementReadModelServiceDeps {
  homeRoot: string;
  runtimeRoot: string;
  config: MoorlineConfig;
  snapshots: RuntimeSnapshotQuery;
  store?: SqliteSessionStore;
  skills: SkillRegistry;
  provider: RuntimeProvider;
  sidecars: SidecarManager;
  now: () => string;
  getRuntimeControlStatus: () => RuntimeControlStatus;
  getRuntimeStatus: ManagementRuntimeStatusProvider;
  getSurfaceState: () => RuntimeSurfaceState | null;
  getManagementSurface: () => {
    enabled: boolean;
    host: string;
    port: number;
    url: string | null;
  };
  getPluginHost?: () => PluginHost;
  createPluginContext?: (actorId: string) => RuntimePluginContext;
  getRuntimeWorkerQueues?: () => ManagementRuntimeWorkerQueueHealthRecord[];
  presentation?: ManagementReadModelPresentation;
}

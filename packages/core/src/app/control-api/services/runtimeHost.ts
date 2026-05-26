import { RuntimeSupervisor } from '../../../core/runtime/supervision/runtimeSupervisor.js';
import { resolveConfigPath, loadMoorlineConfig } from '../../../core/system/config/configStore.js';
import { OperatorPackageService } from '../../bootstrap/operatorPackageService.js';
import { evaluateRuntimeStartability } from '../../../core/extension/packages/runtimeStartability.js';
import { defaultMainProcessConfig, type MainLifecyclePolicy } from '../../../types/config.js';

interface ControlApiMainStatus {
  running: boolean;
  mode: 'runtime' | 'management_only';
  startable: boolean;
  issues: string[];
  policy: MainLifecyclePolicy;
  leases: Array<{
    leaseId: string;
    client: string;
    policy: MainLifecyclePolicy;
    expiresAt: number;
    createdAt: string;
    lastHeartbeatAt: string;
  }>;
}

export interface ControlLeaseRecord {
  leaseId: string;
  client: string;
  policy: MainLifecyclePolicy;
  expiresAt: number;
  createdAt: string;
  lastHeartbeatAt: string;
}

export class ControlApiRuntimeHostService {
  private supervisor: RuntimeSupervisor | null = null;
  private acceptingNewWork = true;

  constructor(
    private readonly input: {
      configPath?: string;
      entrypoint: string;
    }
  ) {}

  async ensureAutostart(): Promise<void> {
    const config = this.loadConfig();
    const main = config.main ?? defaultMainProcessConfig();
    if (!main.autostart) {
      return;
    }
    await this.startMain();
  }

  isRunning(): boolean {
    return this.supervisor !== null;
  }

  mode(): 'runtime' | 'management_only' {
    return this.isRunning() ? 'runtime' : 'management_only';
  }

  runtimeControlStatus(): {
    acceptingNewWork: boolean;
    supervised: boolean;
  } {
    return {
      acceptingNewWork: this.acceptingNewWork,
      supervised: this.isRunning()
    };
  }

  noteAcceptingNewWork(accepting: boolean): void {
    this.acceptingNewWork = accepting;
  }

  async stop(): Promise<void> {
    if (!this.supervisor) {
      return;
    }
    await this.supervisor.stop('graceful');
    this.supervisor = null;
    this.acceptingNewWork = true;
  }

  async startMain(): Promise<{ running: boolean; mode: 'runtime' | 'management_only'; detail: string }> {
    const configPath = this.requireConfigPath();
    const config = this.loadConfig();
    const inventory = new OperatorPackageService(config, configPath).getInventory();
    const startability = evaluateRuntimeStartability(config, inventory);
    if (!startability.startable || !config.transport || !config.provider) {
      return {
        running: false,
        mode: this.mode(),
        detail: startability.issues.join(' | ') || 'Runtime is not startable yet.'
      };
    }
    if (this.supervisor) {
      return {
        running: true,
        mode: 'runtime',
        detail: 'Main process is already running.'
      };
    }
    const supervisor = new RuntimeSupervisor({
      entrypoint: this.input.entrypoint,
      configPath
    });
    await supervisor.start();
    this.supervisor = supervisor;
    this.acceptingNewWork = true;
    return {
      running: true,
      mode: 'runtime',
      detail: 'Main process started.'
    };
  }

  async stopMain(): Promise<{ running: boolean; mode: 'runtime' | 'management_only'; detail: string }> {
    if (!this.supervisor) {
      return {
        running: false,
        mode: this.mode(),
        detail: 'Main process is already stopped.'
      };
    }
    await this.supervisor.stop('graceful');
    this.supervisor = null;
    this.acceptingNewWork = true;
    return {
      running: false,
      mode: 'management_only',
      detail: 'Main process stopped.'
    };
  }

  async restartMain(): Promise<{ running: boolean; mode: 'runtime' | 'management_only'; detail: string }> {
    await this.stopMain();
    return await this.startMain();
  }

  mainStatus(leases: ControlLeaseRecord[]): ControlApiMainStatus {
    const config = this.loadConfig();
    const inventory = new OperatorPackageService(config, this.requireConfigPath()).getInventory();
    const startability = evaluateRuntimeStartability(config, inventory);
    return {
      running: this.isRunning(),
      mode: this.mode(),
      startable: startability.startable && Boolean(config.transport && config.provider),
      issues: startability.issues,
      policy: config.main?.defaultLifecyclePolicy ?? defaultMainProcessConfig().defaultLifecyclePolicy,
      leases
    };
  }

  private loadConfig() {
    return loadMoorlineConfig(this.requireConfigPath());
  }

  private requireConfigPath(): string {
    return resolveConfigPath(this.input.configPath);
  }
}

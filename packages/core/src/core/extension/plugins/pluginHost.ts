import type { RuntimeActionDefinition, RuntimeTransportEvent } from '../../../types/transport.js';
import type {
  AfterAgentResponseInput,
  BeforeAgentPromptInput,
  PluginManifest,
  RuntimeActionDispatchResult,
  RuntimeManagementContribution,
  RuntimePlugin,
  RuntimePluginContext,
  RuntimeToolContext,
  RuntimeToolDefinition
} from '../../../types/plugin.js';
import { validatePluginManifest } from './pluginManifest.js';
import type { ProviderRuntimeEvent } from '../../../types/runtime.js';
import type { RuntimeActivityRecord } from '../../system/projection/runtimeActivityStore.js';
import type { RuntimeDomainEvent, RuntimeReceiptRecord } from '../../runtime/execution/runtimeDomain.js';

type ActionEvent = Extract<RuntimeTransportEvent, { type: 'action.invoked' }>;
type ExternalEvent = Extract<RuntimeTransportEvent, { type: 'external.event.received' }>;
type PluginHookName =
  | 'onRuntimeStarted'
  | 'onTransportEvent'
  | 'onExternalEvent'
  | 'onAction'
  | 'beforeAgentPrompt'
  | 'afterAgentResponse'
  | 'onRuntimeEvent'
  | 'onDomainEvent'
  | 'onRuntimeReceipt'
  | 'onRuntimeActivity';

const DEFAULT_PLUGIN_HOOK_TIMEOUT_MS = 120_000;

export interface PluginHookFailureRecord {
  pluginId: string;
  hook: PluginHookName;
  error: string;
  timeout: boolean;
  timeoutMs: number;
  durationMs: number;
}

interface PluginHostOptions {
  hookTimeoutMs?: number;
  onHookFailure?(failure: PluginHookFailureRecord): void;
}

class PluginHookTimeoutError extends Error {
  constructor(
    readonly pluginId: string,
    readonly hook: PluginHookName,
    readonly timeoutMs: number
  ) {
    super(`Plugin hook timed out after ${timeoutMs}ms.`);
    this.name = 'PluginHookTimeoutError';
  }
}

function normalizeDispatchResult(result: RuntimeActionDispatchResult | boolean | void): RuntimeActionDispatchResult {
  if (typeof result === 'boolean') {
    return { handled: result };
  }
  return result ?? { handled: false };
}

function mergeDispatchResult(left: RuntimeActionDispatchResult, right: RuntimeActionDispatchResult): RuntimeActionDispatchResult {
  return {
    handled: left.handled || right.handled,
    ...(right.reply ?? left.reply ? { reply: right.reply ?? left.reply } : {}),
    ...(right.audit ?? left.audit ? { audit: right.audit ?? left.audit } : {}),
    ...(right.continueDispatch ?? left.continueDispatch
      ? { continueDispatch: right.continueDispatch ?? left.continueDispatch }
      : {})
  };
}

export class PluginHost {
  private readonly plugins: RuntimePlugin[];
  private readonly hookTimeoutMs: number;
  private readonly onHookFailure: (failure: PluginHookFailureRecord) => void;

  constructor(plugins: RuntimePlugin[], options: PluginHostOptions = {}) {
    this.plugins = [...plugins].sort((left, right) => {
      const leftPriority = left.manifest.priority ?? 100;
      const rightPriority = right.manifest.priority ?? 100;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return left.id.localeCompare(right.id);
    });
    for (const plugin of this.plugins) {
      validatePluginManifest(plugin.manifest);
    }
    const configuredTimeoutMs = options.hookTimeoutMs;
    this.hookTimeoutMs =
      typeof configuredTimeoutMs === 'number' && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : DEFAULT_PLUGIN_HOOK_TIMEOUT_MS;
    this.onHookFailure =
      options.onHookFailure ??
      ((failure) => {
        console.error(
          `[plugin.hook.failed] pluginId=${failure.pluginId} hook=${failure.hook} timeout=${failure.timeout} ` +
            `durationMs=${failure.durationMs} error=${failure.error}`
        );
      });
  }

  listPluginManifests(): PluginManifest[] {
    return this.plugins.map((plugin) => plugin.manifest);
  }

  listActions(contextFactory: (pluginId: string) => RuntimePluginContext): RuntimeActionDefinition[] {
    const seen = new Set<string>();
    return this.plugins.flatMap((plugin) => {
      const declaredCapabilities = new Set<string>(plugin.manifest.capabilities);
      return (plugin.actions?.(contextFactory(plugin.id)) ?? []).map((action) => {
        if (seen.has(action.id)) {
          throw new Error(`Duplicate runtime action id: ${action.id}`);
        }
        seen.add(action.id);
        if (action.requiredCapability && !declaredCapabilities.has(action.requiredCapability)) {
          throw new Error(
            `Plugin ${plugin.id} exposes action ${action.id} requiring undeclared capability ${action.requiredCapability}`
          );
        }
        return {
          ...action,
          metadata: {
            ...(action.metadata ?? {}),
            pluginId: plugin.id
          }
        };
      });
    });
  }

  listManagementContributions(contextFactory: (pluginId: string) => RuntimePluginContext): RuntimeManagementContribution[] {
    return this.plugins.flatMap((plugin) => {
      const context = contextFactory(plugin.id);
      const actionIds = new Set((plugin.actions?.(context) ?? []).map((action) => action.id));
      return (plugin.managementContributions?.(context) ?? []).map((contribution) => {
        if (contribution.packageId !== plugin.manifest.id) {
          throw new Error(`Plugin ${plugin.id} returned management contribution ${contribution.id} for ${contribution.packageId}`);
        }
        if (contribution.requiredCapability && !plugin.manifest.capabilities.includes(contribution.requiredCapability)) {
          throw new Error(
            `Plugin ${plugin.id} returned management contribution ${contribution.id} requiring undeclared capability ${contribution.requiredCapability}`
          );
        }
        if (contribution.executeActionId && !actionIds.has(contribution.executeActionId)) {
          throw new Error(
            `Plugin ${plugin.id} returned management contribution ${contribution.id} for undeclared action ${contribution.executeActionId}`
          );
        }
        return contribution;
      });
    });
  }

  listTools(contextFactory: (pluginId: string) => RuntimeToolContext): RuntimeToolDefinition[] {
    return this.plugins.flatMap((plugin) => {
      const declaredCapabilities = new Set(plugin.manifest.capabilities);
      return (plugin.tools?.(contextFactory(plugin.id)) ?? []).map((tool) => {
        if (tool.requiredCapability && !declaredCapabilities.has(tool.requiredCapability)) {
          throw new Error(
            `Plugin ${plugin.id} exposes tool ${tool.name} requiring undeclared capability ${tool.requiredCapability}`
          );
        }
        return {
          ...tool,
          pluginId: plugin.id
        };
      });
    });
  }

  async onRuntimeStarted(contextFactory: (pluginId: string) => RuntimePluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if ((plugin.manifest.hooks ?? []).includes('onRuntimeStarted')) {
        await this.runHook(plugin, 'onRuntimeStarted', async () => {
          await plugin.onRuntimeStarted?.(contextFactory(plugin.id));
        });
      }
    }
  }

  async handleTransportEvent(event: RuntimeTransportEvent, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<RuntimeActionDispatchResult> {
    let result: RuntimeActionDispatchResult = { handled: false };
    for (const plugin of this.plugins) {
      if (!(plugin.manifest.hooks ?? []).includes('onTransportEvent')) {
        continue;
      }
      const next = await this.runRequiredHook(
        plugin,
        'onTransportEvent',
        async () => normalizeDispatchResult(await plugin.onTransportEvent?.(event, contextFactory(plugin.id)))
      );
      if (!next.handled) {
        continue;
      }
      result = mergeDispatchResult(result, next);
      if (!next.continueDispatch) {
        if (event.type === 'external.event.received') {
          break;
        }
        return result;
      }
    }
    if (event.type === 'action.invoked') {
      result = mergeDispatchResult(result, await this.handleAction(event, contextFactory));
    }
    if (event.type === 'external.event.received') {
      result = mergeDispatchResult(result, await this.handleExternalEvent(event, contextFactory));
    }
    return result;
  }

  async handleExternalEvent(event: ExternalEvent, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<RuntimeActionDispatchResult> {
    let result: RuntimeActionDispatchResult = { handled: false };
    for (const plugin of this.plugins) {
      if (!(plugin.manifest.hooks ?? []).includes('onExternalEvent')) {
        continue;
      }
      const next = await this.runRequiredHook(
        plugin,
        'onExternalEvent',
        async () => normalizeDispatchResult(await plugin.onExternalEvent?.(event, contextFactory(plugin.id)))
      );
      if (!next.handled) {
        continue;
      }
      result = mergeDispatchResult(result, next);
      if (!next.continueDispatch) {
        return result;
      }
    }
    return result;
  }

  async handleAction(event: ActionEvent, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<RuntimeActionDispatchResult> {
    let result: RuntimeActionDispatchResult = { handled: false };
    for (const plugin of this.plugins) {
      if (!(plugin.manifest.hooks ?? []).includes('onAction')) {
        continue;
      }
      const next = await this.runRequiredHook(
        plugin,
        'onAction',
        async () => normalizeDispatchResult(await plugin.onAction?.(event, contextFactory(plugin.id)))
      );
      if (!next.handled) {
        continue;
      }
      result = mergeDispatchResult(result, next);
      if (!next.continueDispatch) {
        return result;
      }
    }
    return result;
  }

  async executeAction(
    actionId: string,
    input: Record<string, unknown>,
    actor: { scopeId: string; transportResourceId?: string; actorId: string; displayName?: string },
    contextFactory: (pluginId: string) => RuntimePluginContext
  ): Promise<RuntimeActionDispatchResult> {
    return await this.handleAction(
      {
        type: 'action.invoked',
        scopeId: actor.scopeId,
        ...(actor.transportResourceId ? { transportResourceId: actor.transportResourceId } : {}),
        actor: {
          actorId: actor.actorId,
          ...(actor.displayName ? { displayName: actor.displayName } : {})
        },
        actionId,
        input
      },
      contextFactory
    );
  }

  async beforeAgentPrompt(input: BeforeAgentPromptInput, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<string[]> {
    const sections: string[] = [];
    for (const plugin of this.plugins) {
      if ((plugin.manifest.hooks ?? []).includes('beforeAgentPrompt')) {
        const pluginSections = await this.runHook(
          plugin,
          'beforeAgentPrompt',
          async () => (await plugin.beforeAgentPrompt?.(input, contextFactory(plugin.id))) ?? [],
          []
        );
        sections.push(...pluginSections);
      }
    }
    return sections;
  }

  async afterAgentResponse(input: AfterAgentResponseInput, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if ((plugin.manifest.hooks ?? []).includes('afterAgentResponse')) {
        await this.runHook(plugin, 'afterAgentResponse', async () => {
          await plugin.afterAgentResponse?.(input, contextFactory(plugin.id));
        });
      }
    }
  }

  async onRuntimeEvent(event: ProviderRuntimeEvent, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if ((plugin.manifest.hooks ?? []).includes('onRuntimeEvent')) {
        await this.runHook(plugin, 'onRuntimeEvent', async () => {
          await plugin.onRuntimeEvent?.(event, contextFactory(plugin.id));
        });
      }
    }
  }

  async onDomainEvent(event: RuntimeDomainEvent, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if ((plugin.manifest.hooks ?? []).includes('onDomainEvent')) {
        await this.runHook(plugin, 'onDomainEvent', async () => {
          await plugin.onDomainEvent?.(event, contextFactory(plugin.id));
        });
      }
    }
  }

  async onRuntimeReceipt(receipt: RuntimeReceiptRecord, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if ((plugin.manifest.hooks ?? []).includes('onRuntimeReceipt')) {
        await this.runHook(plugin, 'onRuntimeReceipt', async () => {
          await plugin.onRuntimeReceipt?.(receipt, contextFactory(plugin.id));
        });
      }
    }
  }

  async onRuntimeActivity(activity: RuntimeActivityRecord, contextFactory: (pluginId: string) => RuntimePluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      if ((plugin.manifest.hooks ?? []).includes('onRuntimeActivity')) {
        await this.runHook(plugin, 'onRuntimeActivity', async () => {
          await plugin.onRuntimeActivity?.(activity, contextFactory(plugin.id));
        });
      }
    }
  }

  private async runHook<T>(
    plugin: RuntimePlugin,
    hook: PluginHookName,
    invoke: () => Promise<T>,
    fallback?: T
  ): Promise<T> {
    const started = Date.now();
    try {
      return await this.runWithTimeout(plugin.id, hook, invoke());
    } catch (error) {
      const timeout = error instanceof PluginHookTimeoutError;
      this.reportHookFailure({
        pluginId: plugin.id,
        hook,
        error: error instanceof Error ? error.message : String(error),
        timeout,
        timeoutMs: this.hookTimeoutMs,
        durationMs: Math.max(0, Date.now() - started)
      });
      if (fallback !== undefined) {
        return fallback;
      }
      return undefined as T;
    }
  }

  private async runRequiredHook<T>(plugin: RuntimePlugin, hook: PluginHookName, invoke: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await this.runWithTimeout(plugin.id, hook, invoke());
    } catch (error) {
      const timeout = error instanceof PluginHookTimeoutError;
      this.reportHookFailure({
        pluginId: plugin.id,
        hook,
        error: error instanceof Error ? error.message : String(error),
        timeout,
        timeoutMs: this.hookTimeoutMs,
        durationMs: Math.max(0, Date.now() - started)
      });
      throw error;
    }
  }

  private async runWithTimeout<T>(pluginId: string, hook: PluginHookName, promise: Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = globalThis.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new PluginHookTimeoutError(pluginId, hook, this.hookTimeoutMs));
      }, this.hookTimeoutMs);
      void promise.then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          globalThis.clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          globalThis.clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }

  private reportHookFailure(failure: PluginHookFailureRecord): void {
    try {
      this.onHookFailure(failure);
    } catch (error) {
      console.error(
        `[plugin.hook.failure-handler.error] pluginId=${failure.pluginId} hook=${failure.hook} ` +
          `error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

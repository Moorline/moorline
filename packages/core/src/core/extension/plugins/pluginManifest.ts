export {
  type PluginManifest,
  validatePluginManifest
} from '@moorline/contracts';

import { KNOWN_PLUGIN_HOOKS } from '@moorline/contracts';
import type { RuntimePlugin } from '../../../types/plugin.js';

type KnownPluginHook = (typeof KNOWN_PLUGIN_HOOKS)[number];

export function validatePluginRuntimeContract(plugin: RuntimePlugin): void {
  const declaredHooks = new Set(plugin.manifest.hooks ?? []);
  const implementedHooks = KNOWN_PLUGIN_HOOKS.filter((hook) => typeof plugin[hook] === 'function');

  for (const hook of implementedHooks) {
    if (!declaredHooks.has(hook)) {
      throw new Error(`Plugin ${plugin.id} implements undeclared hook ${hook}`);
    }
  }

  for (const hook of declaredHooks) {
    if (!KNOWN_PLUGIN_HOOKS.includes(hook as KnownPluginHook) || typeof plugin[hook as KnownPluginHook] !== 'function') {
      throw new Error(`Plugin ${plugin.id} declares hook ${hook} but does not implement it`);
    }
  }
}

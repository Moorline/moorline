import type { RuntimeEnvironmentVerifier, RuntimeProviderFactory } from '../../types/provider.js';

let defaultProviderFactory: RuntimeProviderFactory | null = null;
let defaultEnvironmentVerifier: RuntimeEnvironmentVerifier | null = null;

export function getDefaultRuntimeProviderFactory(): RuntimeProviderFactory | null {
  return defaultProviderFactory;
}

export function getDefaultRuntimeEnvironmentVerifier(): RuntimeEnvironmentVerifier | null {
  return defaultEnvironmentVerifier;
}

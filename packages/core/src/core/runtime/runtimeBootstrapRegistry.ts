import type { RuntimeEnvironmentVerifier, RuntimeProviderFactory } from '../../types/provider.js';

let defaultProviderFactory: RuntimeProviderFactory | null = null;
let defaultEnvironmentVerifier: RuntimeEnvironmentVerifier | null = null;

export function registerDefaultRuntimeProviderFactory(factory: RuntimeProviderFactory | null): void {
  defaultProviderFactory = factory;
}

export function getDefaultRuntimeProviderFactory(): RuntimeProviderFactory | null {
  return defaultProviderFactory;
}

export function registerDefaultRuntimeEnvironmentVerifier(verifier: RuntimeEnvironmentVerifier | null): void {
  defaultEnvironmentVerifier = verifier;
}

export function getDefaultRuntimeEnvironmentVerifier(): RuntimeEnvironmentVerifier | null {
  return defaultEnvironmentVerifier;
}

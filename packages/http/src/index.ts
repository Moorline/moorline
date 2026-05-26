import manifest from '../manifest.json' with { type: 'json' };
import {
  type ApiAdapterPackageManifest,
  type RuntimeApiAdapter,
  type RuntimeApiAdapterPackage,
  validateApiAdapterPackageManifest
} from '@moorline/contracts';
import { ControlApiServer } from './server.js';

const packageManifest = validateApiAdapterPackageManifest(manifest as ApiAdapterPackageManifest);

export function createAdapter(input: {
  host: string;
  port: number;
  config: Record<string, unknown>;
  configPath?: string;
  entrypoint: string;
}): RuntimeApiAdapter {
  const server = new ControlApiServer(input);
  return {
    async start() {
      await server.start();
      const url = server.getUrl();
      return {
        endpoints: url
          ? [{
              protocol: 'http',
              url,
              token: server.getApiToken(),
              metadata: {
                adapterPackageId: packageManifest.id
              }
            }]
          : []
      };
    },
    async stop() {
      await server.stop();
    }
  };
}

export async function runHttpAdapter(input: {
  host: string;
  port: number;
  config: Record<string, unknown>;
  configPath?: string;
  entrypoint: string;
  waitForShutdown?: () => Promise<void>;
}): Promise<RuntimeApiAdapter> {
  const server = createAdapter(input);
  await server.start();
  if (input.waitForShutdown) {
    void input.waitForShutdown().finally(() => {
      void server.stop();
    });
  }
  return server;
}

const runtimePackage: RuntimeApiAdapterPackage = {
  manifest: packageManifest,
  createAdapter(input) {
    return createAdapter({
      host: input.host,
      port: input.port,
      config: input.config,
      configPath: input.configPath,
      entrypoint: input.entrypoint
    });
  }
};

export { ControlApiServer };
export default runtimePackage;

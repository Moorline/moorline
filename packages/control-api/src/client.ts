import { ApiBootstrapResolver } from './bootstrap.js';
import type {
  ControlApiBinaryGetPath,
  ControlApiBinaryPostPath,
  ControlApiGetPath,
  ControlApiPayloadForPath,
  ControlApiPostPath,
  ControlApiTextGetPath
} from './contracts/routes.js';

export type MainLifecyclePolicy = 'detached' | 'stop_on_last_lease';

interface ControlApiClientOptions {
  url?: string;
  token?: string;
  configPath?: string;
  autoStart?: boolean;
  entrypoint?: string;
}

export interface ControlApiLeaseBinding {
  leaseId: string;
  release(): Promise<void>;
}

export class ControlApiClient {
  private baseUrl: string | null = null;
  private token: string | null = null;

  constructor(private readonly options: ControlApiClientOptions = {}) {}

  private async ensureConnection(): Promise<void> {
    if (this.baseUrl && this.token) {
      return;
    }
    const resolver = new ApiBootstrapResolver({
      configPath: this.options.configPath,
      ...(this.options.entrypoint ? { entrypoint: this.options.entrypoint } : {})
    });
    const resolved = await resolver.resolveConnection({
      url: this.options.url,
      token: this.options.token,
      configPath: this.options.configPath,
      autoStart: this.options.autoStart
    });
    this.baseUrl = resolved.url.replace(/\/+$/, '');
    this.token = resolved.token.trim();
  }

  async get(path: ControlApiGetPath): Promise<unknown> {
    const response = await this.request(path, { method: 'GET' });
    return response.status === 204 ? null : await response.json();
  }

  async post<Path extends ControlApiPostPath>(path: Path, body: ControlApiPayloadForPath<Path>): Promise<unknown> {
    const response = await this.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return response.status === 204 ? null : await response.json();
  }

  async getText(path: ControlApiTextGetPath): Promise<string> {
    const response = await this.request(path, { method: 'GET' });
    return await response.text();
  }

  async getBinary(path: ControlApiBinaryGetPath): Promise<{ bytes: Uint8Array; contentType: string; contentDisposition: string | null }> {
    const response = await this.request(path, { method: 'GET' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      contentDisposition: response.headers.get('content-disposition')
    };
  }

  async postBinary(path: ControlApiBinaryPostPath, body: Uint8Array | ArrayBuffer, contentType: string): Promise<unknown> {
    const response = await this.request(path, {
      method: 'POST',
      headers: {
        'content-type': contentType
      },
      body
    });
    return response.status === 204 ? null : await response.json();
  }

  private async request(
    path: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string | Uint8Array | ArrayBuffer;
    }
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }> {
    await this.ensureConnection();
    const response = await fetch(`${this.baseUrl!}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token!}`,
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      const payload = await response.text();
      let detail = payload || response.statusText;
      try {
        const parsed = JSON.parse(payload) as { error?: unknown };
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
          detail = parsed.error.trim();
        }
      } catch {
        // Keep payload.
      }
      throw new Error(`Control API request failed (${response.status} ${path}): ${detail}`);
    }
    return response;
  }
}

export async function bindControlApiLease(
  client: Pick<ControlApiClient, 'post'>,
  input: {
    clientName: string;
    policy: MainLifecyclePolicy;
    ttlMs?: number;
  }
): Promise<ControlApiLeaseBinding> {
  const created = (await client.post('/api/leases/create', {
    client: input.clientName,
    policy: input.policy,
    ...(typeof input.ttlMs === 'number' ? { ttlMs: input.ttlMs } : {})
  })) as { leaseId?: unknown };

  if (typeof created.leaseId !== 'string' || created.leaseId.trim().length === 0) {
    throw new Error('Control API lease creation returned an invalid lease id.');
  }

  const leaseId = created.leaseId;
  const ttlMs = Math.max(5_000, input.ttlMs ?? 30_000);
  const heartbeatMs = Math.max(1_000, Math.floor(ttlMs / 2));
  let released = false;
  const timer = globalThis.setInterval(() => {
    if (released) {
      return;
    }
    void client.post('/api/leases/heartbeat', { leaseId, ttlMs }).catch(() => undefined);
  }, heartbeatMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    leaseId,
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      clearInterval(timer);
      await client.post('/api/leases/release', { leaseId }).catch(() => undefined);
    }
  };
}

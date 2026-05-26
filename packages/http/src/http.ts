import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JsonBodyError } from '@moorline/control-api/errors.js';

const MAX_JSON_BODY_BYTES = 1_000_000;
const DEFAULT_MAX_BINARY_BODY_BYTES = 250 * 1024 * 1024;

export function securityHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin'
  };
}

export function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let onData: ((chunk: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onError: ((error: Error) => void) | undefined;

    const contentLengthHeader = request.headers['content-length'];
    const rejectOversize = (options: { destroyStream?: boolean } = {}): void => {
      if (onData) {
        request.removeListener('data', onData);
      }
      if (onEnd) {
        request.removeListener('end', onEnd);
      }
      if (onError) {
        request.removeListener('error', onError);
      }
      request.resume();
      if (options.destroyStream !== false) {
        request.destroy();
      }
      reject(new JsonBodyError(413, `JSON payload exceeds ${MAX_JSON_BODY_BYTES} bytes.`));
    };

    if (typeof contentLengthHeader === 'string') {
      const declaredSize = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_JSON_BODY_BYTES) {
        rejectOversize({ destroyStream: false });
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    onData = (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        rejectOversize();
        return;
      }
      chunks.push(chunk);
    };
    onEnd = () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new JsonBodyError(400, 'JSON body must be an object.'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new JsonBodyError(400, `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    };
    onError = (error: Error) => {
      reject(error);
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

export function readRawBody(
  request: IncomingMessage,
  input: { maxBytes?: number; errorLabel?: string } = {}
): Promise<Buffer> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BINARY_BODY_BYTES;
  const errorLabel = input.errorLabel ?? 'payload';
  return new Promise((resolve, reject) => {
    let onData: ((chunk: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onError: ((error: Error) => void) | undefined;
    const contentLengthHeader = request.headers['content-length'];
    const rejectOversize = (options: { destroyStream?: boolean } = {}): void => {
      if (onData) {
        request.removeListener('data', onData);
      }
      if (onEnd) {
        request.removeListener('end', onEnd);
      }
      if (onError) {
        request.removeListener('error', onError);
      }
      request.resume();
      if (options.destroyStream !== false) {
        request.destroy();
      }
      reject(new JsonBodyError(413, `${errorLabel} exceeds ${maxBytes} bytes.`));
    };

    if (typeof contentLengthHeader === 'string') {
      const declaredSize = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        rejectOversize({ destroyStream: false });
        return;
      }
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    onData = (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        rejectOversize();
        return;
      }
      chunks.push(chunk);
    };
    onEnd = () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0));
    };
    onError = (error: Error) => {
      reject(error);
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

export function assertJsonContentType(request: IncomingMessage, path: string): void {
  const header = request.headers['content-type'];
  const value = (Array.isArray(header) ? header[0] : header ?? '').toLowerCase();
  if (!value.startsWith('application/json')) {
    throw new JsonBodyError(415, `Content-Type must be application/json for ${path}`);
  }
}

export function respondJson(response: ServerResponse, statusCode: number, value: unknown, headers: Record<string, string> = {}): void {
  if (statusCode === 204) {
    response.writeHead(statusCode, {
      'cache-control': 'no-store',
      ...securityHeaders(),
      ...headers
    });
    response.end();
    return;
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...securityHeaders(),
    ...headers
  });
  response.end(JSON.stringify(value));
}

export function isLoopback(request: IncomingMessage): boolean {
  const remote = (request.socket.remoteAddress ?? '').trim().toLowerCase();
  if (!remote) {
    return false;
  }
  if (remote === '::1' || remote === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (isLoopbackIPv4(remote)) {
    return true;
  }
  if (remote.startsWith('::ffff:')) {
    return isLoopbackIPv4(remote.slice('::ffff:'.length));
  }
  return false;
}

function isLoopbackIPv4(address: string): boolean {
  const segments = address.split('.');
  if (segments.length !== 4) {
    return false;
  }
  const octets = segments.map((segment) => Number(segment));
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  return octets[0] === 127;
}

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

let dnsLookup: typeof lookup = lookup;

export function setDnsLookupForTests(fn: typeof lookup): void {
  dnsLookup = fn;
}

export function resetDnsLookupForTests(): void {
  dnsLookup = lookup;
}

function parseIPv4Octets(host: string): [number, number, number, number] | null {
  const segments = host.split('.').map((segment) => Number(segment));
  if (segments.length !== 4 || segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)) {
    return null;
  }
  return [segments[0], segments[1], segments[2], segments[3]];
}

function isPrivateOrLoopbackIPv4(host: string): boolean {
  const octets = parseIPv4Octets(host);
  if (!octets) {
    return false;
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrLoopbackIPv6(host: string): boolean {
  const normalized = host.toLowerCase().split('%')[0] ?? host.toLowerCase();
  if (normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (normalized.startsWith('100:') || normalized.startsWith('100::')) {
    return true;
  }
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  if (normalized.startsWith('ff')) {
    return true;
  }
  if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') {
    return true;
  }
  if (normalized.startsWith('2001:2:') || normalized === '2001:2::') {
    return true;
  }
  if (normalized.startsWith('2001:10:') || normalized === '2001:10::') {
    return true;
  }
  if (normalized.startsWith('64:ff9b:1:') || normalized === '64:ff9b:1::') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (mapped.includes('.')) {
      return isPrivateOrLoopbackIPv4(mapped);
    }
    const parts = mapped.split(':').filter((entry) => entry.length > 0);
    if (parts.length === 2) {
      const left = Number.parseInt(parts[0], 16);
      const right = Number.parseInt(parts[1], 16);
      if (Number.isInteger(left) && Number.isInteger(right) && left >= 0 && left <= 0xffff && right >= 0 && right <= 0xffff) {
        const mappedIPv4 = `${(left >> 8) & 0xff}.${left & 0xff}.${(right >> 8) & 0xff}.${right & 0xff}`;
        return isPrivateOrLoopbackIPv4(mappedIPv4);
      }
    }
    return false;
  }
  return false;
}

export function isPrivateOrLoopbackAddress(host: string): boolean {
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return isPrivateOrLoopbackIPv4(host);
  }
  if (ipVersion === 6) {
    return isPrivateOrLoopbackIPv6(host);
  }
  return false;
}

export async function validateRemoteUrlTarget(input: {
  rawUrl: string;
  allowedProtocols: ReadonlyArray<'http:' | 'https:'>;
  allowPrivateTargets: boolean;
  failOnDnsErrors: boolean;
  sourceLabel: string;
}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(input.rawUrl);
  } catch {
    throw new Error(`${input.sourceLabel} is invalid: ${input.rawUrl}`);
  }

  if (!input.allowedProtocols.includes(parsed.protocol as 'http:' | 'https:')) {
    throw new Error(
      `${input.sourceLabel} protocol must be one of ${input.allowedProtocols.join(', ')}: ${input.rawUrl}`
    );
  }

  if (input.allowPrivateTargets) {
    return parsed;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || isPrivateOrLoopbackAddress(host)) {
    throw new Error(`${input.sourceLabel} is blocked by private-network policy: ${input.rawUrl}`);
  }

  if (isIP(host) !== 0) {
    return parsed;
  }

  try {
    const dnsResults = await dnsLookup(host, { all: true, verbatim: true });
    if (dnsResults.length === 0) {
      throw new Error('no address records returned');
    }
    if (dnsResults.some((entry) => isPrivateOrLoopbackAddress(entry.address))) {
      throw new Error('resolved to local/private address');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'resolved to local/private address') {
      throw new Error(`${input.sourceLabel} resolves to a blocked local/private address: ${input.rawUrl}`);
    }
    if (input.failOnDnsErrors) {
      throw new Error(
        `${input.sourceLabel} DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return parsed;
}

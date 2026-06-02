export const CAPABILITIES = [
  'command.exec',
  'fs.read',
  'fs.write',
  'memory.read',
  'memory.write',
  'session.inspect',
  'session.create',
  'session.direct',
  'session.archive',
  'session.delete',
  'package.state.read',
  'package.state.write',
  'package.job.manage',
  'package.work.manage',
  'provider.headless.run',
  'net.connect',
  'runtime.control',
  'sidecar.manage',
  'transport.message.send',
  'transport.action.register',
  'transport.space.create',
  'transport.space.update',
  'transport.space.delete',
  'transport.native.action.map',
  'transport.native.interaction'
] as const;

export type CoreCapability = (typeof CAPABILITIES)[number];
export type PackageLocalCapability = `package:${string}`;
export type Capability = CoreCapability | PackageLocalCapability;

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value) || value.startsWith('package:');
}

export function isPackageLocalCapability(value: string): value is PackageLocalCapability {
  return value.startsWith('package:');
}

export function packageOwnsCapability(packageId: string, capability: Capability): boolean {
  if (!isPackageLocalCapability(capability)) {
    return true;
  }
  return capability.startsWith(`package:${packageId}.`);
}

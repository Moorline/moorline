export function toPluginPackageId(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith('plugin:') ? normalized.slice('plugin:'.length) : normalized;
}

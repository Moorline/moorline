export function moorlineGitIgnoreTemplate(): string {
  return [
    'config.secrets.json',
    'runtime/coordination/',
    'runtime/logs/',
    'runtime/memory/',
    'runtime/state/',
    'runtime/state.db',
    'runtime/workspaces/'
  ].join('\n') + '\n';
}

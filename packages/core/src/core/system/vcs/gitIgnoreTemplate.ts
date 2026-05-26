export function moorlineGitIgnoreTemplate(): string {
  return [
    'config.secrets.json',
    'runtime/chat/',
    'runtime/logs/',
    'runtime/memory/',
    'runtime/state/',
    'runtime/state.db',
    'runtime/workspaces/'
  ].join('\n') + '\n';
}

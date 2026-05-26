#!/usr/bin/env node

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const warningName =
    warning instanceof Error
      ? warning.name
      : typeof args[0] === 'object' && args[0] !== null && typeof args[0].type === 'string'
        ? args[0].type
        : typeof args[0] === 'string'
          ? args[0]
          : '';
  const warningMessage = warning instanceof Error ? warning.message : String(warning);
  if (warningName === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(warningMessage)) {
    return;
  }
  return emitWarning(warning, ...args);
};

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (!Number.isFinite(major) || major < 22) {
  throw new Error(`Moorline release runtime requires Node.js 22 or newer. Current runtime: ${process.version}`);
}

const sqlite = await import('node:sqlite').catch((error) => {
  throw new Error(`Unable to load node:sqlite from ${process.version}: ${error instanceof Error ? error.message : String(error)}`);
});

if (typeof sqlite.DatabaseSync !== 'function') {
  throw new Error(`node:sqlite loaded from ${process.version}, but DatabaseSync is unavailable.`);
}

const db = new sqlite.DatabaseSync(':memory:');
try {
  db.exec('CREATE TABLE moorline_runtime_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO moorline_runtime_probe (value) VALUES (?)').run('ok');
  const row = db.prepare('SELECT value FROM moorline_runtime_probe WHERE id = 1').get();
  if (!row || row.value !== 'ok') {
    throw new Error('node:sqlite memory round trip returned an unexpected result.');
  }
} finally {
  db.close();
}

console.log(`[moorline:release-runtime] node=${process.version} node:sqlite=ok`);

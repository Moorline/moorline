import { ControlApiClient } from '../src/client.js';

const client = new ControlApiClient({ autoStart: false });

void client.get('/api/state/configure');
void client.get('/api/packages/info?packageId=official/http');
void client.getText('/api/management/diagnostics-export');
void client.getBinary('/api/management/backup?includeWorkspaces=1');
void client.post('/api/leases/create', {
  client: 'typed-test',
  policy: 'stop_on_last_lease',
  ttlMs: 30_000
});
void client.postBinary('/api/management/import', new Uint8Array(), 'application/gzip');

// @ts-expect-error unknown GET routes should not type-check.
void client.get('/api/not-a-route');
// @ts-expect-error required-query GET routes should not accept their bare path.
void client.get('/api/packages/info');
// @ts-expect-error text routes should not be accepted by getBinary.
void client.getBinary('/api/management/diagnostics-export');
// @ts-expect-error unknown binary upload routes should not type-check.
void client.postBinary('/api/not-a-route', new Uint8Array(), 'application/octet-stream');
// @ts-expect-error unknown POST routes should not type-check.
void client.post('/api/not-a-route', {});
// @ts-expect-error lease policy values are constrained by the route contract.
void client.post('/api/leases/create', { policy: 'stopOnLastLease' });

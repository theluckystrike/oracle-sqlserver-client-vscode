'use strict';
// VER16: the ER diagram and schema compare failed on SQL Server with tedious' "Requests can only be made in the
// LoggedIn state, not the SentClientRequest state": they ran 2 schema queries at once on the one meta connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MssqlSession } = require('../src/core/drivers/mssql');

function fakeSession() {
  const s = new MssqlSession({ host: '127.0.0.1', port: 1, user: 'u', auth: 'sql', database: 'db' }, 'pw');
  const log = { connects: 0, maxBusy: 0, order: [] };
  s.connectClient = async () => { log.connects++; await new Promise((r) => setTimeout(r, 15)); return { busy: 0 }; };
  // Like tedious: a second request while one is in flight fails at once.
  s.simple = (conn, sql) => {
    if (conn.busy) return Promise.reject(new Error('Requests can only be made in the LoggedIn state, not the SentClientRequest state'));
    conn.busy = 1;
    return new Promise((resolve) => setTimeout(() => { conn.busy = 0; log.order.push(sql); resolve([{ sql }]); }, 5));
  };
  return { s, log };
}

test('parallel schema queries share one meta connection and run one after another', async () => {
  const { s, log } = fakeSession();
  const r = await Promise.all([s.metaQuery('A'), s.metaQuery('B'), s.metaQuery('C')]);
  assert.deepEqual(r.map((x) => x[0].sql), ['A', 'B', 'C']);
  assert.equal(log.connects, 1);
  // and again once the connection exists (the case that failed in the real app: the schema list ran first)
  const r2 = await Promise.all([s.metaQuery('D'), s.metaQuery('E')]);
  assert.deepEqual(r2.map((x) => x[0].sql), ['D', 'E']);
  assert.equal(log.connects, 1);
});

test('a failed schema query does not block the next one', async () => {
  const { s } = fakeSession();
  const real = s.simple;
  s.simple = (c, sql) => (sql === 'BAD' ? Promise.reject(new Error('Invalid object name')) : real(c, sql));
  const [bad, good] = await Promise.allSettled([s.metaQuery('BAD'), s.metaQuery('OK')]);
  assert.equal(bad.status, 'rejected');
  assert.equal(good.value[0].sql, 'OK');
});

test('an edit transaction waits for running schema queries', async () => {
  const { s, log } = fakeSession();
  s.transactionNow = async () => { const c = await s.metaClient(); assert.equal(c.busy, 0); log.order.push('TX'); return [1]; };
  await Promise.all([s.metaQuery('A'), s.transaction([]), s.metaQuery('B')]);
  assert.deepEqual(log.order, ['A', 'TX', 'B']);
});

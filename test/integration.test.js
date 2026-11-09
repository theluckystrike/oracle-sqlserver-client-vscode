'use strict';
// Integration tests against real servers. Skipped unless ZOVO_SQL_IT=1.
// SQL Server: ZOVO_MSSQL="host,port,user,password" (default 127.0.0.1,14330,sa,Zovo_Sa_2026!) with the zovotest database.
// Oracle: ZOVO_ORA="host:port/service,user,password" (default 127.0.0.1:15210/FREEPDB1,zovo,Zovo_pw_2026) with HR + zovotest objects.
// Build both with test/fixtures/mssql-zovotest.sql and test/fixtures/ora-zovotest.sql.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MssqlSession } = require('../src/core/drivers/mssql');
const { OracleSession } = require('../src/core/drivers/oracle');
const { splitStatements } = require('../src/core/sqlsplit');

const IT = process.env.ZOVO_SQL_IT === '1';
const [mh, mp, mu, mpw] = (process.env.ZOVO_MSSQL || '127.0.0.1,14330,sa,Zovo_Sa_2026!').split(',');
const [ocs, ou, opw] = (process.env.ZOVO_ORA || '127.0.0.1:15210/FREEPDB1,zovo,Zovo_pw_2026').split(',');
const [ohp, osvc] = ocs.split('/');
const ms = (extra = {}) => new MssqlSession({ host: mh, port: Number(mp), user: mu, auth: 'sql', encrypt: 'yes', trustServerCertificate: true, database: 'zovotest', connectTimeoutMs: 10000, ...extra }, extra.password || mpw);
const ora = (extra = {}) => new OracleSession({ method: 'easy', host: ohp.split(':')[0], port: Number(ohp.split(':')[1]), service: osvc, user: ou, connectTimeoutMs: 10000, ...extra }, extra.password || opw);
const opts = { skip: !IT && 'set ZOVO_SQL_IT=1 to run against real servers' };

test('SQL Server: GO batch with PRINT and two result sets', opts, async () => {
  const s = ms();
  try {
    const [b] = splitStatements("PRINT 'hello';\nSELECT 1 AS a;\nSELECT N'東京' AS b, 2 AS c;\nGO", 'mssql');
    const r = await s.runBatch(b.text, 100, {});
    assert.equal(r.sets.length, 2);
    assert.deepEqual(r.sets[1].rows, [['東京', 2]]);
    assert.deepEqual(r.notices.filter((x) => !/affected/.test(x)), ['hello']);
  } finally { await s.close(); }
});

test('SQL Server: 1,000 PRINT lines and 20 result sets from procedures', opts, async () => {
  const s = ms();
  try {
    const r = await s.runBatch('EXEC dbo.print_lines 1000; EXEC dbo.twenty_sets;', 1000, {});
    assert.equal(r.notices.filter((x) => /^message/.test(x)).length, 1000);
    assert.equal(r.sets.length, 20);
    assert.equal(r.sets[19].rows.length, 20);
  } finally { await s.close(); }
});

test('SQL Server: a USE in one run does not leak into the next run of the shared session', opts, async () => {
  const s = ms();
  try {
    await s.runBatch('USE master;', 10, {});
    assert.equal(s.currentDb, 'master');
    await s.startRun();
    const r = await s.runBatch('SELECT DB_NAME() AS db;', 10, {});
    assert.deepEqual(r.sets[0].rows, [['zovotest']]);
    assert.equal(s.currentDb, 'zovotest');
  } finally { await s.close(); }
});

test('SQL Server: 1M-row table pages by 1,000 and Load more continues', opts, async () => {
  const s = ms();
  try {
    const r = await s.runBatch('SELECT * FROM dbo.big_rows ORDER BY id', 1000, {});
    const set = r.sets[0];
    assert.equal(set.rows.length, 1000);
    assert.equal(set.done, false);
    const more = await set.fetchMore(1000);
    assert.equal(more.length, 1000);
    assert.equal(more[0][0], 1001);
    await set.close();
    const after = await s.runBatch('SELECT COUNT(*) FROM dbo.big_rows', 10, {});
    assert.equal(after.sets[0].rows[0][0], 1000000);
  } finally { await s.close(); }
});

test('SQL Server: 10 MB nvarchar(max) cells stay whole in the host, page stops at the byte budget', opts, async () => {
  const s = ms();
  try {
    const r = await s.runBatch('SELECT id, body FROM dbo.big_text ORDER BY id', 1000, {});
    const set = r.sets[0];
    assert.ok(set.rows[0][1].length > 10e6);
    let n = set.rows.length;
    while (!set.done) n += (await set.fetchMore(1000)).length;
    assert.equal(n, 7);
  } finally { await s.close(); }
});

test('SQL Server: cancel stops WAITFOR within a second and the session keeps working', opts, async () => {
  const s = ms();
  try {
    await s.open();
    const t0 = Date.now();
    const p = s.runBatch("WAITFOR DELAY '00:01:00'; SELECT 1", 10, {}).then(() => 'finished', (e) => e.message);
    setTimeout(() => s.cancel(), 500);
    assert.match(await p, /cancelled/);
    assert.ok(Date.now() - t0 < 5000);
    const r = await s.runBatch("SELECT 'ok'", 10, {});
    assert.equal(r.sets[0].rows[0][0], 'ok');
  } finally { await s.close(); }
});

test('SQL Server: read-only rolls back what a procedure writes', opts, async () => {
  const admin = ms();
  const ro = ms({ readOnly: true });
  try {
    const before = (await admin.runBatch('SELECT COUNT(*) FROM dbo.big_text', 10, {})).sets[0].rows[0][0];
    await ro.runBatch('EXEC dbo.write_row', 10, {});
    const after = (await admin.runBatch('SELECT COUNT(*) FROM dbo.big_text', 10, {})).sets[0].rows[0][0];
    assert.equal(after, before);
  } finally { await ro.close(); await admin.close(); }
});

test('SQL Server: wrong password and error line', opts, async () => {
  const bad = ms({ password: 'wrong-password' });
  await assert.rejects(bad.open(), /refused the login/);
  const s = ms();
  try {
    await assert.rejects(s.runBatch('SELECT 1;\nSELECT nope FROM dbo.big_rows;', 10, {}), (e) => e.line === 1);
  } finally { await s.close(); }
});

test('SQL Server: streamed export of 1M rows', opts, async () => {
  const s = ms();
  try {
    let n = 0;
    const r = await s.exportQuery('SELECT * FROM dbo.big_rows', async (cols, rows) => { n += rows.length; });
    assert.equal(n, 1000000);
    assert.equal(r.rows, 1000000);
  } finally { await s.close(); }
});

test('SQL Server: explorer queries', opts, async () => {
  const s = ms();
  try {
    assert.ok((await s.databases()).includes('zovotest'));
    assert.equal((await s.schemas())[0].name, 'dbo');
    const t = await s.tables('dbo');
    assert.ok(t.find((x) => x.name === 'big_rows').rows >= 1000000);
    assert.ok((await s.routines('dbo')).some((x) => x.name === 'print_lines' && x.kind === 'procedure'));
    assert.ok((await s.columns('dbo', 'big_rows')).find((c) => c.name === 'id').pk);
    assert.match(await s.ddl('dbo', 'print_lines', 'procedure'), /CREATE\s+PROCEDURE dbo\.print_lines/i);
  } finally { await s.close(); }
});

test('Oracle: DBMS_OUTPUT, implicit results, CLOBs, unicode', opts, async () => {
  const s = ora();
  try {
    let r = await s.runBatch('BEGIN print_lines(1000); END;', 100, {});
    assert.equal(r.notices.length, 1000);
    r = await s.runBatch('BEGIN twenty_sets; END;', 100, {});
    assert.equal(r.sets.length, 20);
    r = await s.runBatch('SELECT body FROM big_text WHERE id = 1', 10, {});
    assert.ok(r.sets[0].rows[0][0].length > 10e6);
    r = await s.runBatch('SELECT * FROM "Ünïcödé_表"', 10, {});
    assert.deepEqual(r.sets[0].columns.map((c) => c.name), ['名前', 'émoji', 'עברית']);
    r = await s.runBatch("SELECT DATE '2026-11-09' AS d, 12345678901234567890.123 AS n FROM dual", 10, {});
    assert.deepEqual(r.sets[0].rows[0], ['2026-11-09 00:00:00', '12345678901234567890.123']);
  } finally { await s.close(); }
});

test('Oracle: SQL*Plus script lines, cancel, read-only session, compile errors', opts, async () => {
  const s = ora();
  const ro = ora({ readOnly: true });
  try {
    const st = splitStatements('SET SERVEROUTPUT OFF\nPROMPT hi\n', 'oracle');
    assert.equal((await s.runBatch(st[0].text, 10, { client: true })).notices[0], 'DBMS_OUTPUT is off for this session.');
    assert.equal((await s.runBatch(st[1].text, 10, { client: true })).notices[0], 'hi');
    const p = s.runBatch('SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c', 10, {}).then(() => 'finished', (e) => e.message);
    setTimeout(() => s.cancel(), 500);
    assert.match(await p, /cancelled/);
    await assert.rejects(ro.runBatch('BEGIN write_row; END;', 10, {}), /ORA-28193/);
    await assert.rejects(s.runBatch('CREATE OR REPLACE PROCEDURE it_bad AS\nBEGIN\n  zz := 1;\nEND;', 10, {}), (e) => e.line === 2 && /compilation errors/.test(e.message));
    await assert.rejects(s.runBatch('SELECT nope FROM dual', 10, {}), (e) => e.position === 7);
  } finally { await ro.close(); await s.close(); }
});

test('Oracle: streamed export of 1M rows and explorer queries', opts, async () => {
  const s = ora();
  try {
    let n = 0;
    await s.exportQuery('SELECT * FROM big_rows', async (cols, rows) => { n += rows.length; });
    assert.equal(n, 1000000);
    assert.equal((await s.schemas())[0].name, 'ZOVO');
    assert.ok((await s.tables('ZOVO')).some((t) => t.name === 'EMPLOYEES'));
    assert.match(await s.ddl('ZOVO', 'BIG_ROWS', 'table'), /CREATE TABLE "ZOVO"\."BIG_ROWS"/);
    const plan = await s.explain('SELECT * FROM employees WHERE salary > 1000');
    assert.ok(plan.rows.some((r) => r.OPERATION === 'TABLE ACCESS'));
  } finally { await s.close(); }
});

test('Oracle: SELECT * on a table with INTERVAL columns returns rows (was NJS-119)', opts, async () => {
  const s = ora();
  try {
    await s.runBatch("BEGIN EXECUTE IMMEDIATE 'DROP TABLE it_intervals'; EXCEPTION WHEN OTHERS THEN NULL; END;", 10, {});
    await s.runBatch('CREATE TABLE it_intervals (ds INTERVAL DAY TO SECOND, ym INTERVAL YEAR TO MONTH)', 10, {});
    await s.runBatch("INSERT INTO it_intervals VALUES (INTERVAL '3 04:05:06.7' DAY TO SECOND, INTERVAL '1-2' YEAR TO MONTH)", 10, {});
    const r = await s.runBatch('SELECT * FROM it_intervals', 10, {});
    assert.deepEqual(r.sets[0].rows, [['+3 04:05:06.7', '+1-02']]);
    await s.runBatch('DROP TABLE it_intervals', 10, {});
  } finally { await s.close(); }
});

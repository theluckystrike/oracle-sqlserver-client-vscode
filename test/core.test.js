'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitStatements, statementAt, riskyStatements, writeKeyword, isWrappable, skeleton } = require('../src/core/sqlsplit');
const { quoteIdent, quoteLiteral, editStatements, wrapQuery, selectTop, selectAll, insertLine } = require('../src/core/dialect');
const { parseConnectionString, validate, displayUrl } = require('../src/core/connstr');
const { checkTnsnames, tnsAliases, cellValue: oraCell } = require('../src/core/drivers/oracle');
const oracledb = require('oracledb');
const { friendlyError, isConnectionLost } = require('../src/core/drivers/errors');
const { dateText, typeLabel } = require('../src/core/drivers/mssql');
const { gridCell, csvLine } = require('../src/core/values');

// ---------- T-SQL ----------

test('T-SQL: GO lines split batches; GO inside strings, comments and [names] does not', () => {
  const sql = "CREATE TABLE [go] (x int)\nGO\nPRINT 'line\nGO\nstill string'\n/* GO\n*/\nSELECT 1 -- GO\ngo 3\nSELECT 2";
  const b = splitStatements(sql, 'mssql');
  assert.equal(b.length, 3);
  assert.equal(b[0].text, 'CREATE TABLE [go] (x int)');
  assert.match(b[1].text, /^PRINT 'line\nGO\nstill string'/);
  assert.equal(b[1].repeat, 3);
  assert.equal(b[2].text, 'SELECT 2');
  assert.equal(sql.slice(b[2].start, b[2].end), 'SELECT 2');
});

test('T-SQL: run at cursor picks the statement, or the whole batch when it has variables or blocks', () => {
  const plain = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
  assert.equal(statementAt(plain, plain.indexOf('2'), 'mssql').text, 'SELECT 2');
  const vars = "DECLARE @n int = 5;\nSELECT @n;\nPRINT 'x';";
  assert.equal(statementAt(vars, vars.indexOf('SELECT'), 'mssql').text, vars);
  const proc = 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND';
  assert.equal(statementAt(proc, proc.indexOf('SELECT 2'), 'mssql').text, proc);
});

test('T-SQL: semicolons in [identifiers] and N strings do not split', () => {
  const s = "SELECT [a;b] FROM t WHERE x = N'semi;colon';\nSELECT 2;";
  assert.equal(statementAt(s, 3, 'mssql').text, "SELECT [a;b] FROM t WHERE x = N'semi;colon'");
});

// ---------- Oracle ----------

test('Oracle: ; ends SQL, / ends PL/SQL blocks, SQL*Plus lines are client commands', () => {
  const sql = [
    'SET SERVEROUTPUT ON',
    "SELECT 'a;b' FROM dual;",
    'CREATE OR REPLACE PROCEDURE p AS',
    'BEGIN',
    "  DBMS_OUTPUT.PUT_LINE('x;y');",
    'END;',
    '/',
    'BEGIN p; END;',
    '/',
    "INSERT INTO t VALUES (q'[it's; fine]');",
    'PROMPT done',
    'SET TRANSACTION READ ONLY;',
  ].join('\n');
  const st = splitStatements(sql, 'oracle');
  assert.deepEqual(st.map((x) => [x.text.split('\n')[0], !!x.client, !!x.plsql]), [
    ['SET SERVEROUTPUT ON', true, false],
    ["SELECT 'a;b' FROM dual", false, false],
    ['CREATE OR REPLACE PROCEDURE p AS', false, true],
    ['BEGIN p; END;', false, true],
    ["INSERT INTO t VALUES (q'[it's; fine]')", false, false],
    ['PROMPT done', true, false],
    ['SET TRANSACTION READ ONLY', false, false],
  ]);
  assert.match(st[2].text, /END;$/);
});

test('Oracle: a block without a closing / runs to the end; comments before statements are skipped', () => {
  const sql = '-- header\n/* c */\nDECLARE\n  n NUMBER;\nBEGIN\n  n := 1;\nEND;';
  const st = splitStatements(sql, 'oracle');
  assert.equal(st.length, 1);
  assert.match(st[0].text, /^DECLARE/);
});

test('Oracle: run at cursor returns the block around the cursor', () => {
  const sql = 'SELECT 1 FROM dual;\nBEGIN\n  NULL;\nEND;\n/\nSELECT 2 FROM dual;';
  assert.match(statementAt(sql, sql.indexOf('NULL'), 'oracle').text, /^BEGIN/);
  assert.equal(statementAt(sql, sql.indexOf('2 FROM'), 'oracle').text, 'SELECT 2 FROM dual');
});

// ---------- safety checks ----------

test('risky statements: UPDATE/DELETE without WHERE, TRUNCATE, DROP; procedure bodies are not checked', () => {
  assert.deepEqual(riskyStatements('UPDATE t SET a = 1', 'mssql'), ['UPDATE without WHERE']);
  assert.deepEqual(riskyStatements('UPDATE t SET a = 1 WHERE id = 2', 'mssql'), []);
  assert.deepEqual(riskyStatements("DELETE FROM t; SELECT 'WHERE'", 'mssql'), ['DELETE without WHERE']);
  assert.deepEqual(riskyStatements('TRUNCATE TABLE t', 'oracle'), ['TRUNCATE']);
  assert.deepEqual(riskyStatements('DROP TABLE t', 'oracle'), ['DROP TABLE']);
  assert.deepEqual(riskyStatements('CREATE OR REPLACE PROCEDURE p AS BEGIN DELETE FROM t; END;', 'oracle'), []);
  assert.deepEqual(riskyStatements('SELECT * FROM t -- DELETE FROM t', 'mssql'), []);
  assert.deepEqual(riskyStatements("SELECT 'DROP TABLE x' FROM dual", 'oracle'), []);
});

test('read-only client check: writes found, reads and FOR UPDATE wording pass', () => {
  assert.equal(writeKeyword('INSERT INTO t VALUES (1)', 'oracle'), 'INSERT');
  assert.equal(writeKeyword('SELECT * INTO #tmp FROM t', 'mssql'), 'SELECT INTO');
  assert.equal(writeKeyword("SELECT 'DELETE' AS x FROM dual", 'oracle'), '');
  assert.equal(writeKeyword('SELECT REPLACE(a, \'x\', \'y\') FROM t', 'mssql'), '');
  assert.equal(writeKeyword('EXEC dbo.report', 'mssql'), ''); // the server-side guard handles procedures
  assert.equal(writeKeyword('COMMIT', 'mssql'), 'COMMIT');
});

test('server-side sort wraps only plain queries', () => {
  assert.equal(isWrappable('SELECT * FROM t', 'mssql'), true);
  assert.equal(isWrappable('SELECT * FROM t ORDER BY 1', 'mssql'), false);
  assert.equal(isWrappable('SELECT TOP 10 * FROM t ORDER BY 1', 'mssql'), true);
  assert.equal(isWrappable('SELECT * FROM t ORDER BY 1', 'oracle'), true);
  assert.equal(isWrappable('SELECT * FROM t FOR UPDATE', 'oracle'), false);
  assert.equal(isWrappable('SELECT 1; SELECT 2', 'mssql'), false);
  assert.match(wrapQuery('SELECT * FROM t', 'oracle', { col: 2, desc: true }, [{ name: 'a"b', text: '50%_x' }]), /\) zovo_q\nWHERE UPPER\(TO_CHAR\(zovo_q\."a""b"\)\) LIKE UPPER\('%50\\%\\_x%'\) ESCAPE '\\'\nORDER BY 2 DESC NULLS LAST/);
  assert.match(wrapQuery('SELECT * FROM t', 'mssql', null, [{ name: 'a]b', text: '[x]' }]), /AS zovo_q\nWHERE CAST\(zovo_q\.\[a\]\]b\] AS NVARCHAR\(MAX\)\) LIKE N'%\\\[x\]%' ESCAPE '\\'/);
});

// ---------- dialect ----------

test('quoting and literals per dialect', () => {
  assert.equal(quoteIdent('a]b', 'mssql'), '[a]]b]');
  assert.equal(quoteIdent('a"b', 'oracle'), '"a""b"');
  assert.equal(quoteLiteral("it's", 'mssql'), "N'it''s'");
  assert.equal(quoteLiteral("it's", 'oracle'), "'it''s'");
  assert.equal(quoteLiteral(Buffer.from([1, 255]), 'mssql'), '0x01FF');
  assert.equal(quoteLiteral(Buffer.from([1, 255]), 'oracle'), "HEXTORAW('01FF')");
  assert.match(quoteLiteral('x'.repeat(4500), 'oracle'), /^TO_CLOB\('x{1000}'\) \|\| /);
  assert.equal(selectTop('dbo', 'T', 'mssql'), 'SELECT TOP 100 * FROM [dbo].[T];');
  assert.equal(selectTop('HR', 'EMPLOYEES', 'oracle'), 'SELECT * FROM "HR"."EMPLOYEES"\nFETCH FIRST 100 ROWS ONLY;');
  assert.equal(insertLine('t', ['a', 'b'], ['1', null], 'mssql'), "INSERT INTO [t] ([a], [b]) VALUES (N'1', NULL);\n");
  const ed = editStatements({ schema: 'HR', table: 'T', pk: ['ID'] }, [{ kind: 'update', key: { ID: '5' }, set: { NAME: 'Zoë' } }, { kind: 'delete', key: { ID: '6' } }], 'oracle');
  assert.deepEqual(ed.map((x) => x.sql), [`UPDATE "HR"."T" SET "NAME" = 'Zoë' WHERE "ID" = '5'`, `DELETE FROM "HR"."T" WHERE "ID" = '6'`]);
});

// ---------- connection strings ----------

test('connection strings: ADO.NET, JDBC and URL forms for SQL Server', () => {
  const a = parseConnectionString('Server=tcp:db.example.com,1444;Database=Sales;User Id=app;Password=p;w;Encrypt=True;TrustServerCertificate=True');
  assert.equal(a.type, 'mssql'); assert.equal(a.host, 'db.example.com'); assert.equal(a.port, 1444); assert.equal(a.database, 'Sales'); assert.equal(a.user, 'app'); assert.equal(a.trustServerCertificate, true);
  const b = parseConnectionString('Data Source=SQL01\\PROD;Initial Catalog=HR;Integrated Security=SSPI');
  assert.equal(b.instance, 'PROD'); assert.equal(b.auth, 'ntlm'); assert.equal(b.database, 'HR');
  const c = parseConnectionString('jdbc:sqlserver://localhost:1433;databaseName=master;user=sa;encrypt=false');
  assert.equal(c.port, 1433); assert.equal(c.database, 'master'); assert.equal(c.encrypt, 'no');
  const d = parseConnectionString('sqlserver://sa:p%40ss@localhost:14330/AdventureWorks?trustServerCertificate=true');
  assert.equal(d.password, 'p@ss'); assert.equal(d.port, 14330); assert.equal(d.trustServerCertificate, true);
  const e = parseConnectionString('Server=CORP\\ann;Database=x;User Id=CORP\\ann;Password=y');
  assert.equal(e.auth, 'ntlm'); assert.equal(e.domain, 'CORP'); assert.equal(e.user, 'ann');
});

test('connection strings: Oracle Easy Connect, JDBC, SQL*Plus and TNS aliases', () => {
  assert.deepEqual(parseConnectionString('localhost:1521/FREEPDB1'), { type: 'oracle', method: 'easy', host: 'localhost', port: 1521, service: 'FREEPDB1' });
  const j = parseConnectionString('jdbc:oracle:thin:@db.local:1522:ORCL');
  assert.equal(j.sid, 'ORCL'); assert.equal(j.port, 1522);
  const s = parseConnectionString('hr/secret@db.local:1521/XEPDB1');
  assert.equal(s.user, 'hr'); assert.equal(s.password, 'secret'); assert.equal(s.service, 'XEPDB1');
  const t = parseConnectionString('scott@MYDB_HIGH');
  assert.equal(t.method, 'tns'); assert.equal(t.tnsAlias, 'MYDB_HIGH');
  assert.throws(() => parseConnectionString('postgres://u@h/db'), /Postgres & MySQL client/);
  assert.throws(() => parseConnectionString('hello there'), /not recognised/);
});

test('validate and displayUrl never hold a password', () => {
  assert.deepEqual(validate({ type: 'mssql', name: 'x', host: 'h', port: 1433, auth: 'sql' }), []);
  assert.ok(validate({ type: 'oracle', name: 'x', method: 'easy', host: 'h', port: 1521, user: 'u' }).some((e) => /service name/.test(e)));
  assert.ok(validate({ type: 'mssql', name: 'x', host: 'h', port: 1433, auth: 'ntlm' }).some((e) => /NTLM/.test(e)));
  assert.equal(displayUrl({ type: 'mssql', host: 'h', port: 1433, user: 'sa', database: 'db', password: 'nope' }), 'sqlserver://sa@h:1433/db');
  assert.equal(displayUrl({ type: 'oracle', method: 'easy', host: 'h', port: 1521, service: 'S', user: 'hr' }), 'hr@h:1521/S');
});

test('tnsnames.ora check: syntax errors and missing aliases get a clear sentence', () => {
  const good = 'A = (DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=h)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=s)))\n# comment (\nB.WORLD, C = (DESCRIPTION=(ADDRESS=(HOST=x)))';
  assert.equal(checkTnsnames(good, 'A'), '');
  assert.equal(checkTnsnames(good, 'b'), '');
  assert.deepEqual(tnsAliases(good), ['A', 'B.WORLD', 'C']);
  assert.match(checkTnsnames('A = (DESCRIPTION=(ADDRESS=(HOST=h)\n', 'A'), /missing 2 closing/);
  assert.match(checkTnsnames('A = (DESCRIPTION=))', 'A'), /line 1 has no matching/);
  assert.match(checkTnsnames(good, 'ZZ'), /alias "ZZ" is not in this file/);
});

test('errors: clear sentences, positions kept, no secrets', () => {
  const ora = friendlyError(Object.assign(new Error('ORA-00904: "NOPE": invalid identifier\nHelp: x'), { offset: 7, errorNum: 904 }), { host: 'h', port: 1521 }, 'oracle');
  assert.equal(ora.position, 7);
  const ms = friendlyError(Object.assign(new Error("Invalid column name 'x'."), { number: 207, lineNumber: 3 }), {}, 'mssql');
  assert.equal(ms.line, 2);
  const login = friendlyError(Object.assign(new Error("Login failed for user 'sa'."), { code: 'ELOGIN', number: 18456 }), { host: 'h', port: 1433, user: 'sa' }, 'mssql');
  assert.match(login.message, /refused the login for "sa"/);
  const oraPw = friendlyError(new Error('ORA-01017: invalid credential or not authorized; logon denied'), { user: 'zovo' }, 'oracle');
  assert.match(oraPw.message, /refused the user name or password for "zovo"/);
  assert.ok(isConnectionLost(new Error('NJS-500: connection to the Oracle Database was broken')));
  assert.ok(isConnectionLost({ code: 'ESOCKET', message: 'Connection lost - read ECONNRESET' }));
  assert.match(friendlyError({ code: 'ECANCEL', message: 'Canceled.' }, {}, 'mssql').message, /cancelled/);
});

test('SQL Server values: dates as SQL Server shows them, type labels', () => {
  const d = new Date(Date.UTC(2026, 10, 9, 14, 5, 6, 70));
  assert.equal(dateText(d, 'datetime2'), '2026-11-09 14:05:06.070');
  assert.equal(dateText(d, 'daten'), '2026-11-09');
  assert.equal(typeLabel({ type: { name: 'NVarChar' }, dataLength: 100 }), 'nvarchar(50)');
  assert.equal(typeLabel({ type: { name: 'NVarChar' }, dataLength: 65535 }), 'nvarchar(max)');
  assert.equal(typeLabel({ type: { name: 'IntN' }, dataLength: 8 }), 'bigint');
  assert.equal(typeLabel({ type: { name: 'DecimalN' }, precision: 12, scale: 2 }), 'decimal(12,2)');
});

test('grid cells: a 10 MB text value sends only a 2,000 character preview to the webview', () => {
  const big = 'x'.repeat(10 * 1024 * 1024);
  const cell = gridCell(big);
  assert.equal(cell.t, 'long');
  assert.equal(cell.s.length, 2000);
  assert.equal(cell.n, big.length);
  assert.equal(csvLine(['a,b', null, 'é']), '"a,b",,é\r\n');
});

test('skeleton keeps offsets and blanks strings', () => {
  const s = "SELECT 'x' -- c\nFROM [t]";
  assert.equal(skeleton(s, 'mssql').length, s.length);
  assert.ok(!skeleton(s, 'mssql').includes('x'));
});

test('explorer table open names the SQL Server database, so a USE elsewhere cannot change it', () => {
  assert.equal(selectAll('dbo', 'big_rows', 'mssql', 'zovotest'), 'SELECT * FROM [zovotest].[dbo].[big_rows]');
  assert.equal(selectAll('dbo', 'x]y', 'mssql', 'a]b'), 'SELECT * FROM [a]]b].[dbo].[x]]y]');
  assert.equal(selectAll('ZOVO', 'BIG_ROWS', 'oracle'), 'SELECT * FROM "ZOVO"."BIG_ROWS"');
});

test('UPDATE STATISTICS is not an UPDATE without WHERE', () => {
  assert.deepEqual(riskyStatements('UPDATE STATISTICS publishers\nUPDATE STATISTICS jobs\nGO', 'mssql'), []);
  assert.deepEqual(riskyStatements('UPDATE t SET a = 1', 'mssql'), ['UPDATE without WHERE']);
});

test('Oracle: REM and REMARK lines are comments, not statements', () => {
  const st = splitStatements('rem\nREM Copyright (c) 2023 Oracle\nremark x\nSELECT 1 FROM dual;\nrem end\n', 'oracle');
  assert.equal(st.length, 1);
  assert.match(st[0].text, /^SELECT 1 FROM dual/);
});

test('Oracle: INTERVAL values show as Oracle text, not as an error or JSON', () => {
  assert.equal(oraCell(new oracledb.IntervalDS({ days: 3, hours: 4, minutes: 5, seconds: 6, fseconds: 700000000 })), '+3 04:05:06.7');
  assert.equal(oraCell(new oracledb.IntervalDS({ days: -1, hours: -2, minutes: 0, seconds: 0, fseconds: 0 })), '-1 02:00:00');
  assert.equal(oraCell(new oracledb.IntervalYM({ years: 1, months: 2 })), '+1-02');
  assert.equal(oraCell(new oracledb.IntervalYM({ years: 0, months: -5 })), '-0-05');
});

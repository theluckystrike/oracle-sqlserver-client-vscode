'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildHtml } = require('../src/html');
const { completionItems, aliases } = require('../src/completion');
const { schemaText, schemaDiffSummary, planTree, PRO_ENABLED } = require('../src/pro');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('webview CSP: default-src none, scripts by nonce only, no remote sources', () => {
  const html = buildHtml({ cspSource: 'vscode-webview://x', scriptUri: 'vscode-webview://x/w.js', styleUri: 'vscode-webview://x/s.css', title: '<t>', page: 'grid', nonce: 'abc', data: { x: '</script><script>alert(1)</script>' } });
  const csp = /content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'(;|$)/);
  assert.match(csp, /img-src vscode-webview:\/\/x blob: data:/);
  assert.ok(!/https?:/.test(csp));
  assert.ok(!html.includes('</script><script>alert'));
  assert.ok(html.includes('&lt;t&gt;'));
});

test('package.json: engine floor, display name words, every command has a title', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  const name = pkg.displayName.toLowerCase();
  // Main phrases stay together in the name (NICHE6: split phrases rank far lower).
  for (const phrase of ['oracle sql', 'sql server', 'query client', 'mssql', 't-sql', 'plsql', 'oracle database']) assert.ok(name.includes(phrase), `"${phrase}" in name`);
  assert.ok(!/pl\/sql/i.test(pkg.displayName), 'PL/SQL is another listing\'s whole name');
  assert.ok(!/sql server client/i.test(pkg.displayName), 'SQL Server Client is another product name');
  assert.ok(!/sql developer/i.test(pkg.displayName));
  assert.ok(pkg.description.includes('alternative to heavy desktop SQL tools'));
  assert.deepEqual(pkg.activationEvents, ['onLanguage:sql']);
  assert.equal(PRO_ENABLED, false, 'ships with every feature free');
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8') + fs.readFileSync(path.join(root, 'src/pro.js'), 'utf8');
  const listed = new Set(pkg.contributes.commands.map((c) => c.command));
  const registered = [...src.matchAll(/reg\('([A-Za-z]+)'/g)].map((m) => `zovoOra.${m[1]}`);
  for (const id of registered) assert.ok(listed.has(id), `${id} listed in package.json`);
  for (const id of ['zovoOra.supportDeveloper', 'zovoOra.moreViewers', 'zovoOra.enterLicenseKey', 'zovoOra.getPro', 'zovoOra.unlockWithSponsors', 'zovoOra.removeLicense']) assert.ok(listed.has(id));
});

test('no telemetry, no update check: no fetch or http client in our sources', () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(root, 'src'));
  for (const f of files) {
    if (f.includes(`${path.sep}license${path.sep}`)) continue; // the Sponsors rail talks to GitHub only after a user click (own tests)
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/\bfetch\(|require\('https?'\)|XMLHttpRequest|setInterval\(/.test(s), `${path.relative(root, f)} has no network call or polling`);
  }
});

test('autocomplete: columns after alias dot, [bracketed] names, dialect keywords', () => {
  const schema = [{ name: 'Person', kind: 'table', schema: 'dbo', columns: [{ name: 'Id', type: 'int', pk: true }, { name: 'Email', type: 'nvarchar(100)' }] }, { name: 'Orders', kind: 'table', schema: 'dbo', columns: [{ name: 'PersonId', type: 'int' }] }];
  const cols = completionItems({ schema, dialect: 'mssql', linePrefix: 'select p.', statement: 'select p. from [dbo].[Person] p join Orders o on o.PersonId = p.Id' });
  assert.deepEqual(cols.map((c) => c.label), ['Id', 'Email']);
  const all = completionItems({ schema, dialect: 'oracle', linePrefix: 'select * from ', statement: 'select * from ' });
  assert.ok(all.some((c) => c.label === 'Orders' && c.kind === 'table'));
  assert.ok(all.some((c) => c.label === 'DBMS_OUTPUT.PUT_LINE'));
  assert.ok(completionItems({ schema, dialect: 'mssql', linePrefix: '', statement: '' }).some((c) => c.label === 'CROSS APPLY'));
  assert.equal(aliases('update [Person] as pp set x=1').get('pp'), 'Person');
});

test('plan tree: Oracle PLAN_TABLE rows and SQL Server showplan XML', () => {
  const o = planTree({ format: 'oracle', rows: [{ ID: 0, DEPTH: 0, OPERATION: 'SELECT STATEMENT', COST: 3, CARDINALITY: 1 }, { ID: 1, DEPTH: 1, OPERATION: 'TABLE ACCESS', OPTIONS: 'FULL', OBJECT_OWNER: 'HR', OBJECT_NAME: 'EMPLOYEES', COST: 3, CARDINALITY: 107, FILTER_PREDICATES: '"SALARY">1000' }] });
  assert.match(o, /  TABLE ACCESS FULL HR\.EMPLOYEES/);
  assert.match(o, /filter: "SALARY">1000/);
  const x = '<ShowPlanXML><RelOp NodeId="0" PhysicalOp="Hash Match" LogicalOp="Inner Join" EstimateRows="10" EstimatedTotalSubtreeCost="0.5"><RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="100" EstimatedTotalSubtreeCost="0.1"><Object Table="[Person]" Index="[PK_Person]"/></RelOp></RelOp></ShowPlanXML>';
  const m = planTree({ format: 'showplan', text: x });
  assert.match(m, /^Hash Match \(Inner Join\)/m);
  assert.match(m, /^  Clustered Index Scan \[Person\]\.\[PK_Person\]/m);
});

test('schema compare text is sorted and stable; summary counts', () => {
  const a = [{ name: 'b', kind: 'table', columns: [{ name: 'id', type: 'int', pk: true, notNull: true }] }, { name: 'a', kind: 'table', columns: [{ name: 'x', type: 'text' }] }];
  const b = [{ name: 'a', kind: 'table', columns: [{ name: 'x', type: 'varchar' }] }, { name: 'c', kind: 'view', columns: [] }];
  const t = schemaText(a, [{ name: 'f', table: 'b', columns: ['id'], refTable: 'a', refColumns: ['x'] }], 'left');
  assert.ok(t.indexOf('TABLE a (') < t.indexOf('TABLE b ('));
  assert.match(t, /FOREIGN KEY \(id\) REFERENCES a \(x\)/);
  assert.deepEqual(schemaDiffSummary(a, b), { onlyA: 1, onlyB: 1, changed: 1 });
});


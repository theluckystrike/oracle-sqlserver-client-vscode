'use strict';
// Zovo Pro features: execution plan view, schema compare, ER diagram (SVG), DDL export of a whole schema and the
// saved query library. Everything else (connections, queries, explorer, Script as CREATE, cancel, export, read-only
// mode, history, autocomplete, DBMS_OUTPUT and PRINT) is free and stays free.
// PRO_ENABLED = false (as shipped): every Pro feature is free too, with no label, no counter and no dialog.
// When the owner turns it on, each Pro feature can be tried 3 times; then one quiet explanation offers the unlock
// (GitHub Sponsors Zovo tier, USD 19 once, or a license key; both checked without a server of ours).

const fs = require('fs');
const { createLicense } = require('./license');
const { buildHtml } = require('./html');

const PRO_ENABLED = false;
const FREE_TRIES = 3;
const SKU = 'oracle-sqlserver-client-pro';
const TRIES_KEY = 'zovoOra.proTries';
const SAVED_KEY = 'zovoOra.savedQueries';

function createPro(vscode, context) {
  // name 'Zovo' makes the label "Zovo Pro": one purchase for every Zovo extension.
  const license = createLicense({ vscode, context, sku: SKU, name: 'Zovo', commandPrefix: 'zovoOra' });

  /** True when the user may run the feature now (unlocked, a free try left, or the user unlocked it in the dialog). */
  async function allow(feature, detail) {
    if (!PRO_ENABLED) return true;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh().catch(() => {}); return true; }
    const tries = context.globalState.get(TRIES_KEY, {});
    const used = Number(tries[feature] || 0);
    if (used < FREE_TRIES) {
      tries[feature] = used + 1;
      await context.globalState.update(TRIES_KEY, tries);
      return true;
    }
    return license.requirePro(feature, `${detail} You used your ${FREE_TRIES} free tries. Zovo Pro is USD 19 once on GitHub Sponsors (the Zovo Pro tier) and unlocks Pro in every Zovo extension. Already bought it? Choose Unlock with GitHub Sponsors (one question to GitHub, nothing else is sent). Queries, the explorer, export and every connection stay free.`);
  }

  return { license, allow, enabled: PRO_ENABLED };
}

// ---------- ER diagram ----------

async function showErDiagram(vscode, context, session, schema, title) {
  const [tables, fks] = await Promise.all([session.schemaColumns(schema, 20000), session.foreignKeys(schema)]);
  const max = 200;
  const shown = tables.slice(0, max);
  const names = new Set(shown.map((t) => t.name));
  const panel = vscode.window.createWebviewPanel('zovoOra.er', `ER: ${title}`, vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
  });
  panel.webview.html = buildHtml({
    cspSource: panel.webview.cspSource,
    scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
    styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
    title: `ER: ${title}`, page: 'er', footer: false,
    data: { title, truncated: tables.length > max, tables: shown, fks: fks.filter((f) => names.has(f.table) && names.has(f.refTable)) },
  });
  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || m.type !== 'saveSvg' || typeof m.svg !== 'string') return;
    const target = await vscode.window.showSaveDialog({ title: 'Save the ER diagram', filters: { SVG: ['svg'] }, defaultUri: vscode.workspace.workspaceFolders ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `${String(title).replace(/[^\w.-]+/g, '_')}-er.svg`) : undefined });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(m.svg, 'utf8'));
    vscode.window.showInformationMessage(`Saved ${target.path.split('/').pop()}.`);
  });
  return panel;
}

// ---------- schema compare ----------

/** A stable, sorted text description of a schema, one table per block, for a side-by-side diff. */
function schemaText(tables, fks, label) {
  const lines = [`-- ${label}`, `-- ${tables.length} tables and views`, ''];
  const byTable = new Map();
  for (const f of fks) { if (!byTable.has(f.table)) byTable.set(f.table, []); byTable.get(f.table).push(f); }
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${t.name} (`);
    for (const c of t.columns) lines.push(`  ${c.name} ${c.type}${c.notNull ? ' NOT NULL' : ''}${c.default != null ? ` DEFAULT ${c.default}` : ''}${c.pk ? ' PRIMARY KEY' : ''}`);
    for (const f of (byTable.get(t.name) || []).sort((a, b) => a.name.localeCompare(b.name))) lines.push(`  FOREIGN KEY (${f.columns.join(', ')}) REFERENCES ${f.refTable} (${f.refColumns.join(', ')})`);
    lines.push(')', '');
  }
  return lines.join('\n');
}

/** Counts of tables and columns only in A, only in B, or changed. */
function schemaDiffSummary(a, b) {
  const ma = new Map(a.map((t) => [t.name, t]));
  const mb = new Map(b.map((t) => [t.name, t]));
  let onlyA = 0; let onlyB = 0; let changed = 0;
  for (const [n, t] of ma) {
    const u = mb.get(n);
    if (!u) { onlyA++; continue; }
    const ca = t.columns.map((c) => `${c.name} ${c.type} ${c.notNull} ${c.pk}`).join('|');
    const cb = u.columns.map((c) => `${c.name} ${c.type} ${c.notNull} ${c.pk}`).join('|');
    if (ca !== cb) changed++;
  }
  for (const n of mb.keys()) if (!ma.has(n)) onlyB++;
  return { onlyA, onlyB, changed };
}

// ---------- execution plan ----------

/** Plan rows as an indented text tree: SQL Server showplan XML or Oracle PLAN_TABLE rows. */
function planTree(plan) {
  const lines = [];
  if (plan.format === 'oracle') {
    lines.push('Id  Operation' + ' '.repeat(52) + 'Rows        Cost');
    for (const r of plan.rows || []) {
      const op = `${'  '.repeat(Number(r.DEPTH) || 0)}${r.OPERATION}${r.OPTIONS ? ` ${r.OPTIONS}` : ''}${r.OBJECT_NAME ? ` ${r.OBJECT_OWNER ? r.OBJECT_OWNER + '.' : ''}${r.OBJECT_NAME}` : ''}`;
      lines.push(`${String(r.ID).padStart(2)}  ${op.padEnd(60)} ${String(r.CARDINALITY ?? '').padStart(10)}  ${String(r.COST ?? '').padStart(6)}`);
      if (r.ACCESS_PREDICATES) lines.push(`      access: ${r.ACCESS_PREDICATES}`);
      if (r.FILTER_PREDICATES) lines.push(`      filter: ${r.FILTER_PREDICATES}`);
    }
    return lines.join('\n');
  }
  // SQL Server: walk the RelOp elements of the showplan XML (no XML library: the format is regular).
  const xml = String(plan.text || '');
  const re = /<(\/?)RelOp\b([^>]*)>/g;
  let depth = 0;
  let m;
  lines.push('Operation' + ' '.repeat(56) + 'Est. rows    Cost');
  while ((m = re.exec(xml))) {
    if (m[1]) { depth--; continue; }
    const attr = (n) => { const x = new RegExp(`\\b${n}="([^"]*)"`).exec(m[2]); return x ? x[1] : ''; };
    const after = xml.slice(m.index, m.index + 4000);
    const obj = /<Object\b[^>]*Table="([^"]*)"(?:[^>]*Index="([^"]*)")?/.exec(after);
    const op = `${'  '.repeat(depth)}${attr('PhysicalOp')}${attr('LogicalOp') && attr('LogicalOp') !== attr('PhysicalOp') ? ` (${attr('LogicalOp')})` : ''}${obj ? ` ${obj[1]}${obj[2] ? `.${obj[2]}` : ''}` : ''}`;
    lines.push(`${op.padEnd(64)} ${String(Math.round(Number(attr('EstimateRows')) || 0)).padStart(10)}  ${(Number(attr('EstimatedTotalSubtreeCost')) || 0).toFixed(4).padStart(8)}`);
    if (!/\/>\s*$/.test(m[0])) depth++;
  }
  if (lines.length === 1) lines.push('(no plan operators: the statement may not need a plan)');
  return lines.join('\n');
}

async function showPlan(vscode, context, plan, title) {
  const text = `-- ${title}\n-- Estimated plan. The query did not run.\n\n${planTree(plan)}\n${plan.format === 'showplan' ? `\n-- Showplan XML\n${plan.text}\n` : ''}`;
  const doc = await vscode.workspace.openTextDocument({ language: 'plaintext', content: text });
  await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

// ---------- schema DDL export ----------

/** CREATE statements of every table, view, procedure, function and package of a schema, written to one file. */
async function exportSchemaDdl(session, schema, file, opts = {}) {
  const tables = await session.tables(schema);
  const routines = await session.routines(schema).catch(() => []);
  const all = [...tables.filter((t) => t.kind === 'table'), ...tables.filter((t) => t.kind === 'view'), ...routines];
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  const write = (s) => new Promise((resolve) => { if (out.write(s)) resolve(); else out.once('drain', resolve); });
  await write(`-- DDL of schema ${schema}, ${all.length} objects, ${new Date().toISOString()}\n\n`);
  let n = 0;
  for (const o of all) {
    if (opts.shouldStop && opts.shouldStop()) break;
    try {
      await write(`-- ${o.kind} ${o.name}\n${await session.ddl(schema, o.name, o.kind)}\n`);
      n++;
    } catch (e) {
      await write(`-- ${o.kind} ${o.name}: could not read the definition (${String(e.message).split('\n')[0]})\n\n`);
    }
    if (opts.onProgress) opts.onProgress(n, all.length);
  }
  await new Promise((resolve) => out.end(resolve));
  return n;
}

// ---------- saved queries ----------

function savedQueries(context) {
  const x = context.globalState.get(SAVED_KEY, []);
  return Array.isArray(x) ? x : [];
}

async function saveQuery(context, item) {
  const list = savedQueries(context).filter((q) => q.name !== item.name);
  list.unshift({ ...item, savedAt: new Date().toISOString() });
  await context.globalState.update(SAVED_KEY, list.slice(0, 500));
}

async function deleteSavedQuery(context, name) {
  await context.globalState.update(SAVED_KEY, savedQueries(context).filter((q) => q.name !== name));
}

module.exports = { createPro, showErDiagram, schemaText, schemaDiffSummary, planTree, showPlan, exportSchemaDdl, savedQueries, saveQuery, deleteSavedQuery, PRO_ENABLED, FREE_TRIES, SKU };

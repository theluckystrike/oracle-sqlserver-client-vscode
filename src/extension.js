'use strict';
// Zovo Oracle SQL & SQL Server Query Client: SQL Server, Azure SQL and Oracle Database in VS Code.
// Drivers are pure JavaScript (tedious, node-oracledb Thin mode) and load on first use: activation does no I/O.
// Network: only to the database hosts the user adds. No telemetry, no update check, no license server
// (the optional GitHub Sponsors unlock asks GitHub one question, only when the user clicks it).
// Nothing runs while the user does nothing: no keep-alive, no polling, no connect on startup.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { ConnectionStore, SessionManager } = require('./connections');
const { ExplorerProvider } = require('./tree');
const { ResultsPanel, runExport } = require('./results');
const { splitStatements, statementAt } = require('./core/sqlsplit');
const { selectAll, selectTop, qualified } = require('./core/dialect');
const { validate, displayUrl, parseConnectionString } = require('./core/connstr');
const { riskyStatements, writeKeyword } = require('./core/sqlsplit');
const { completionItems } = require('./completion');
const { buildHtml } = require('./html');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');
const pro = require('./pro');

const BIND_KEY = 'zovoOra.bindings';
const HISTORY_KEY = 'zovoOra.history';
const DIALECT_NAME = { mssql: 'SQL Server', oracle: 'Oracle' };
const EXT_ID = 'zovo.zovo-oracle-sqlserver-client';

let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('zovoOra');
  return {
    rowLimit: Math.max(1, Math.floor(c.get('rowLimit', 1000))),
    maxLoadedRows: Math.max(1000, Math.floor(c.get('maxLoadedRows', 100000))),
    history: c.get('history', true),
    historySize: c.get('historySize', 200),
    confirmUnboundedWrites: c.get('confirmUnboundedWrites', true),
    connectTimeoutSeconds: c.get('connectTimeoutSeconds', 10),
    dbmsOutput: c.get('oracleDbmsOutput', true),
    oracleAutoCommit: c.get('oracleAutoCommit', true),
  };
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'zovoOra', name: 'Oracle SQL & SQL Server Query Client' });
  registerSupport({ vscode, context, prefix: 'zovoOra', selfId: EXT_ID });
  const proApi = pro.createPro(vscode, context);
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => proApi.license.handleUri(uri) }));

  const store = new ConnectionStore(vscode, context);
  const sessions = new SessionManager(vscode, context, store, settings);
  const tree = new ExplorerProvider(vscode, store, sessions);
  const treeView = vscode.window.createTreeView('zovoOra.connections', { treeDataProvider: tree, showCollapseAll: true });
  const diagnostics = vscode.languages.createDiagnosticCollection('zovoOra');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'zovoOra.selectConnection';
  context.subscriptions.push(treeView, diagnostics, status);

  sessions.onDrop = (session, role, err) => {
    if (role === 'main') vscode.window.showWarningMessage(`${connLabel(store.get(session.connId))}: the connection dropped. The next query reconnects. (${err.message})`);
    tree.refresh();
  };

  // ---------- bindings: which connection a .sql file runs on ----------
  const bindings = new Map(Object.entries(context.workspaceState.get(BIND_KEY, {})));
  const saveBindings = () => context.workspaceState.update(BIND_KEY, Object.fromEntries([...bindings].slice(-500)));
  const bindingOf = (doc) => {
    const b = bindings.get(doc.uri.toString());
    if (!b || !store.get(b.conn)) return null;
    return b;
  };
  const bind = (doc, b) => { bindings.set(doc.uri.toString(), b); saveBindings(); updateStatus(); schemaCache.delete(doc.uri.toString()); };

  function connLabel(c) { return c ? c.name : 'Connection'; }

  function updateStatus() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'sql') { status.hide(); return; }
    const b = bindingOf(ed.document);
    const c = b && store.get(b.conn);
    status.text = c ? `$(database) ${c.name}${b.database ? ` · ${b.database}` : ''}${b.schema ? `.${b.schema}` : ''}${c.readOnly ? ' $(lock)' : ''}` : '$(database) Choose connection';
    status.tooltip = c ? `${DIALECT_NAME[c.type]}: ${displayUrl(c)}\nClick to change the connection of this file.` : 'Pick the connection this SQL file runs on.';
    status.show();
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatus), store.onDidChange(updateStatus));
  updateStatus();

  async function pickConnection(title) {
    const list = store.list();
    if (!list.length) {
      const pick = await vscode.window.showInformationMessage('Add a database connection first.', 'Add Connection');
      if (pick) await vscode.commands.executeCommand('zovoOra.addConnection');
      return null;
    }
    const item = await vscode.window.showQuickPick(list.map((c) => ({ label: `$(database) ${c.name}`, description: DIALECT_NAME[c.type], detail: displayUrl(c) + (c.readOnly ? ' · read-only' : ''), c })), { title: title || 'Run on which connection?', matchOnDetail: true });
    return item ? item.c : null;
  }

  /** The connection, database and session for a node or a binding. */
  function sessionDbFor(c, database) {
    if (c.type === 'mssql') return database && database !== c.database ? database : '';
    return '';
  }

  async function bindingSession(b) {
    const c = store.get(b.conn);
    const session = await sessions.get(c.id, sessionDbFor(c, b.database));
    return { conn: c, session, readOnly: c.readOnly, database: b.database };
  }

  // ---------- running queries ----------
  let running = 0;
  const setRunning = (d) => { running = Math.max(0, running + d); vscode.commands.executeCommand('setContext', 'zovoOra.running', running > 0); };

  const history = (binding, sql) => {
    if (!settings().history) return;
    const all = context.globalState.get(HISTORY_KEY, {});
    const id = binding.conn.id;
    const list = (all[id] || []).filter((x) => x.sql !== sql);
    list.unshift({ sql, at: new Date().toISOString(), db: binding.database || '' });
    all[id] = list.slice(0, settings().historySize);
    context.globalState.update(HISTORY_KEY, all);
  };

  async function run(mode) {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showInformationMessage('Open a .sql file, or click New Query on a connection.'); return; }
    const doc = ed.document;
    let b = bindingOf(doc);
    if (!b) {
      const c = await pickConnection();
      if (!c) return;
      b = { conn: c.id, database: c.type === 'oracle' ? '' : c.database || '' };
      bind(doc, b);
    }
    const c = store.get(b.conn);
    const text = doc.getText();
    let stmts;
    const sel = ed.selection;
    if (!sel.isEmpty) {
      const base = doc.offsetAt(sel.start);
      stmts = splitStatements(doc.getText(sel), c.type).map((s) => ({ ...s, start: s.start + base, end: s.end + base }));
    } else if (mode === 'all') stmts = splitStatements(text, c.type);
    else {
      const one = statementAt(text, doc.offsetAt(sel.active), c.type);
      stmts = one ? [one] : [];
    }
    if (!stmts.length) { vscode.window.showInformationMessage('There is no SQL statement at the cursor.'); return; }
    if (c.readOnly) {
      for (const s of stmts) {
        if (s.client) continue;
        const w = writeKeyword(s.text, c.type);
        if (w) {
          vscode.window.showWarningMessage(`${c.name} is read-only, so ${w} statements are blocked. Nothing was sent to the server. Turn off read-only in the connection's menu to change data.`);
          return;
        }
      }
    }
    if (settings().confirmUnboundedWrites) {
      const risky = [];
      for (const s of stmts) for (const r of riskyStatements(s.text, c.type)) risky.push({ r, s });
      if (risky.length) {
        const first = risky[0].s.text.replace(/\s+/g, ' ').slice(0, 160);
        const kinds = [...new Set(risky.map((x) => x.r))].join(', ');
        const hasWhere = /WHERE/.test(kinds);
        const hasDrop = /TRUNCATE|DROP/.test(kinds);
        const what = hasWhere && hasDrop ? 'They change every row of a table or remove data for good.' : hasWhere ? 'It changes every row of the table.' : 'It removes data for good.';
        const go = await vscode.window.showWarningMessage(`This runs ${kinds}. ${what} Run it?`, { modal: true, detail: first }, 'Run anyway');
        if (go !== 'Run anyway') return;
      }
    }
    diagnostics.delete(doc.uri);
    let binding;
    try {
      binding = await bindingSession(b);
    } catch (e) {
      if (!e.cancelled) vscode.window.showErrorMessage(e.message);
      return;
    }
    const title = `Results: ${path.posix.basename(doc.uri.path)}`;
    const column = ed.viewColumn === vscode.ViewColumn.One || !ed.viewColumn ? vscode.ViewColumn.Beside : ed.viewColumn;
    const panel = ResultsPanel.forKey(deps, `doc:${doc.uri.toString()}`, title, column);
    setRunning(1);
    let ok;
    try {
      ok = await panel.run(binding, stmts, {
        onError: (st, e) => markError(doc, st, e),
        onStatementDone: (st) => history(binding, st.text),
        // USE in the file: the file follows it (as in SSMS); other files keep their database.
        onDatabaseChange: (db) => { if (c.type === 'mssql') bind(doc, { ...b, database: db }); },
      });
    } finally { setRunning(-1); }
    if (ok) rating.success(); else if (binding.session && !binding.session.main) rating.failure();
    // No tree refresh here: a refresh reads every expanded level again, and the server should only see the user's query.
  }

  function markError(doc, st, e) {
    let range;
    if (typeof e.position === 'number') {
      const at = doc.positionAt(st.start + Math.min(e.position, st.text.length));
      range = doc.getWordRangeAtPosition(at) || new vscode.Range(at, at.translate(0, 1));
    } else if (typeof e.line === 'number') {
      const startLine = Math.min(doc.positionAt(st.start).line + e.line, doc.lineCount - 1);
      const line = doc.lineAt(startLine);
      if (typeof e.column === 'number' && e.column >= 0) {
        const at = new vscode.Position(startLine, Math.min(e.column, line.text.length));
        range = doc.getWordRangeAtPosition(at) || new vscode.Range(at, at.translate(0, 1));
      } else range = new vscode.Range(line.firstNonWhitespaceCharacterIndex ? line.range.start.translate(0, line.firstNonWhitespaceCharacterIndex) : line.range.start, line.range.end);
    } else range = new vscode.Range(doc.positionAt(st.start), doc.positionAt(st.end));
    const d = new vscode.Diagnostic(range, e.message || String(e), vscode.DiagnosticSeverity.Error);
    d.source = DIALECT_NAME[(store.get((bindingOf(doc) || {}).conn) || {}).type] || 'SQL';
    diagnostics.set(doc.uri, [d]);
    const ed = vscode.window.visibleTextEditors.find((x) => x.document === doc);
    if (ed) ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => { if (diagnostics.has(e.document.uri)) diagnostics.delete(e.document.uri); }));

  const deps = { vscode, context, sessions, store, settings, rating, history: (b, sql) => history(b, sql) };

  async function cancel() {
    const panels = ResultsPanel.all().filter((p) => p.running);
    if (!panels.length) { vscode.window.showInformationMessage('No query is running.'); return; }
    for (const p of panels) await p.cancel();
  }

  // ---------- autocomplete ----------
  const schemaCache = new Map();
  async function schemaFor(doc) {
    const key = doc.uri.toString();
    if (schemaCache.has(key)) return schemaCache.get(key);
    const b = bindingOf(doc);
    if (!b) return [];
    const p = (async () => {
      const { conn, session } = await bindingSession(b);
      const info = await session.open();
      const first = conn.type === 'oracle' ? info.schema : (b.schema || 'dbo');
      const schemas = (await session.schemas()).map((x) => x.name);
      const order = [first, ...schemas.filter((x) => x !== first)].slice(0, 10);
      const out = [];
      let budget = 20000;
      for (const sc of order) {
        if (budget <= 0) break;
        const t = await session.schemaColumns(sc, budget).catch(() => []);
        budget -= t.reduce((a, x) => a + x.columns.length, 0);
        out.push(...t.map((x) => ({ ...x, schema: sc })));
      }
      return out;
    })().catch(() => { schemaCache.delete(key); return []; });
    schemaCache.set(key, p);
    return p;
  }

  const kindMap = { table: vscode.CompletionItemKind.Struct, view: vscode.CompletionItemKind.Interface, column: vscode.CompletionItemKind.Field, keyword: vscode.CompletionItemKind.Keyword };
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider({ language: 'sql' }, {
    async provideCompletionItems(doc, pos) {
      const b = bindingOf(doc);
      if (!b) return undefined;
      const c = store.get(b.conn);
      const text = doc.getText();
      const st = statementAt(text, doc.offsetAt(pos), c.type);
      const items = completionItems({ schema: await schemaFor(doc), dialect: c.type, linePrefix: doc.lineAt(pos.line).text.slice(0, pos.character), statement: st ? st.text : '' });
      return items.map((i) => {
        const it = new vscode.CompletionItem(i.label, kindMap[i.kind]);
        it.detail = i.detail;
        it.sortText = `${i.sort}${i.label}`;
        return it;
      });
    },
  }, '.'));

  // ---------- connection form ----------
  async function openForm(existing) {
    const panel = vscode.window.createWebviewPanel('zovoOra.form', existing ? `Edit ${existing.name}` : 'New Connection', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'table.svg');
    const hasPassword = existing ? !!(await store.password(existing.id)) : false;
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.css')).toString(),
      title: 'Connection', page: 'form', footer: false, data: { conn: existing || null, hasPassword },
    });
    const testSession = async (conn, password, walletPassword) => {
      const { createSession } = require('./connections');
      let pw = password;
      if (pw === undefined && existing) pw = await store.password(existing.id);
      let wpw = walletPassword;
      if (wpw === undefined && existing) wpw = await store.walletPassword(existing.id);
      const cfg = { ...conn, walletPassword: wpw, connectTimeoutMs: settings().connectTimeoutSeconds * 1000, dbmsOutput: false };
      const s = createSession(conn.type, cfg, pw);
      const t0 = Date.now();
      try {
        const info = await s.open();
        return `Connected in ${Date.now() - t0} ms. ${String(info.version).split(' - ')[0].slice(0, 90)}${info.database ? `, database ${info.database}` : ''}${info.user ? `, user ${info.user}` : ''}.`;
      } finally { await s.close(); }
    };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (!m) return;
      if (m.type === 'cancel') { panel.dispose(); return; }
      if (m.type === 'browse') {
        const r = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true, title: m.what === 'wallet' ? 'Wallet folder (holds ewallet.pem)' : 'Folder that holds tnsnames.ora' });
        if (r && r[0]) {
          const dir = r[0].fsPath;
          let aliases = [];
          try { aliases = require('./core/drivers/oracle').tnsAliases(fs.readFileSync(path.join(dir, 'tnsnames.ora'), 'utf8')); } catch { /* no file */ }
          panel.webview.postMessage({ type: 'browsed', what: m.what, path: dir, aliases });
        }
        return;
      }
      if (m.type === 'parse') {
        try {
          panel.webview.postMessage({ type: 'parsed', ok: true, conn: parseConnectionString(m.text) });
        } catch (e) {
          panel.webview.postMessage({ type: 'parsed', ok: false, message: e.message });
        }
        return;
      }
      if (m.type !== 'test' && m.type !== 'save') return;
      const conn = m.conn || {};
      const errs = validate(conn);
      if (errs.length) { panel.webview.postMessage({ type: m.type === 'test' ? 'tested' : 'saved', ok: false, message: errs.join('\n') }); return; }
      if (m.type === 'test') {
        try {
          panel.webview.postMessage({ type: 'tested', ok: true, message: await testSession(conn, m.password, m.walletPassword) });
        } catch (e) {
          panel.webview.postMessage({ type: 'tested', ok: false, message: e.message || String(e) });
        }
        return;
      }
      if (m.type === 'save') {
        const saved = await store.save({ ...conn, id: existing ? existing.id : undefined }, m.password);
        if (m.walletPassword !== undefined) await store.setWalletPassword(saved.id, m.walletPassword);
        await sessions.close(saved.id);
        tree.refresh();
        panel.dispose();
        vscode.window.showInformationMessage(`Saved ${saved.name}.${conn.savePassword === false ? ' The password will be asked once per window.' : ''}`);
        vscode.commands.executeCommand('zovoOra.connections.focus');
      }
    });
  }

  // ---------- helpers for tree nodes ----------
  async function nodeSession(node) {
    const c = store.get(node.conn);
    if (!c) throw new Error('This connection was deleted.');
    return { c, session: await sessions.get(c.id, node.sessionDb !== undefined ? node.sessionDb : sessionDbFor(c, node.database)) };
  }

  async function newQueryFor(node, initial) {
    let c = node && node.conn ? store.get(node.conn) : null;
    if (!c) c = await pickConnection('New query on which connection?');
    if (!c) return;
    const database = node && node.database ? node.database : (c.type === 'oracle' ? '' : c.database || '');
    const comment = `-- ${c.name}${database && database !== c.name ? ` · ${database}` : ''}${node && node.schema ? ` · ${node.schema}` : ''}\n`;
    let use = '';
    if (!initial && node && node.schema) {
      if (c.type === 'oracle' && node.schema !== (await sessions.get(c.id, '').then((s) => s.open()).then((i) => i.schema).catch(() => node.schema))) use = `ALTER SESSION SET CURRENT_SCHEMA = "${node.schema.replace(/"/g, '""')}";\n`;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: comment + (initial || use) });
    bind(doc, { conn: c.id, database, schema: node && node.schema });
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const end = doc.positionAt(doc.getText().length);
    ed.selection = new vscode.Selection(end, end);
    return ed;
  }

  async function schemaNodePick(node, title) {
    // From a schema node, or a picked connection and schema.
    if (node && node.conn && node.schema) {
      const { c, session } = await nodeSession(node);
      return { c, session, schema: node.schema, label: `${c.name}${node.database ? ` · ${node.database}` : ''} · ${node.schema}` };
    }
    let c = node && node.conn ? store.get(node.conn) : null;
    if (!c) c = await pickConnection(title);
    if (!c) return null;
    const session = await sessions.get(c.id, sessionDbFor(c, node && node.database ? node.database : c.database));
    const info = await session.open();
    const list = await session.schemas();
    const p = await vscode.window.showQuickPick(list.map((x) => ({ label: x.name, description: x.count === null ? '' : `${x.count} tables and views` })), { title: 'Which schema?', placeHolder: c.type === 'oracle' ? info.schema : 'dbo' });
    if (!p) return null;
    return { c, session, schema: p.label, label: `${c.name} · ${p.label}` };
  }

  const guard = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { if (!e || !e.cancelled) vscode.window.showErrorMessage((e && e.message) || String(e)); return undefined; }
  };

  // ---------- commands ----------
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(`zovoOra.${id}`, guard(fn)));
  reg('addConnection', () => openForm(null));
  reg('editConnection', (node) => {
    const c = node && store.get(node.conn);
    if (c) return openForm(c);
    return pickConnection('Edit which connection?').then((x) => x && openForm(x));
  });
  reg('deleteConnection', async (node) => {
    const c = node ? store.get(node.conn) : await pickConnection('Delete which connection?');
    if (!c) return;
    const ok = await vscode.window.showWarningMessage(`Delete the connection "${c.name}"? Its saved password is removed too. The database itself is not touched.`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await sessions.close(c.id);
    await store.remove(c.id);
  });
  reg('disconnect', async (node) => {
    const c = node ? store.get(node.conn) : await pickConnection('Disconnect which connection?');
    if (!c) return;
    await sessions.close(c.id);
    tree.refresh();
    vscode.window.setStatusBarMessage(`Disconnected ${c.name}.`, 3000);
  });
  reg('refresh', async (node) => {
    schemaCache.clear();
    if (node && node.conn && node.kind === 'connection') await sessions.close(node.conn);
    tree.refresh(node && node.kind !== 'connection' ? undefined : undefined);
  });
  reg('toggleReadOnly', async (node) => {
    const c = node ? store.get(node.conn) : await pickConnection('Read-only on which connection?');
    if (!c) return;
    await store.save({ ...c, readOnly: !c.readOnly });
    await sessions.close(c.id);
    vscode.window.showInformationMessage(`${c.name} is now ${!c.readOnly ? 'read-only. Every change is blocked' : 'writable'}.`);
  });
  reg('newQuery', (node) => newQueryFor(node));
  reg('runStatement', () => run('statement'));
  reg('runAll', () => run('all'));
  reg('cancel', () => cancel());
  reg('selectConnection', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const c = await pickConnection('Run this file on which connection?');
    if (!c) return;
    let database = c.type === 'oracle' ? '' : c.database || '';
    if (c.type === 'mssql') {
      try {
        const s = await sessions.get(c.id, sessionDbFor(c, c.database));
        const dbs = await s.databases();
        if (dbs.length > 1) {
          // The connection's own database comes first, so Enter keeps it.
          const ordered = [...dbs.filter((d) => d === database), ...dbs.filter((d) => d !== database)];
          const p = await vscode.window.showQuickPick(ordered.map((d) => ({ label: d, description: d === database ? 'default' : '' })), { title: `Database on ${c.name}` });
          if (!p) return;
          database = p.label;
        }
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
        return;
      }
    }
    bind(ed.document, { conn: c.id, database });
  });
  reg('openTable', async (node) => {
    if (!node || !node.table) return;
    const { c, session } = await nodeSession(node);
    const binding = { conn: c, session, readOnly: c.readOnly, database: node.database };
    const name = node.schema ? `${node.schema}.${node.table}` : node.table;
    const panel = ResultsPanel.forKey(deps, `table:${c.id}:${node.database || ''}:${node.schema || ''}:${node.table}`, name, vscode.ViewColumn.Active);
    setRunning(1);
    try {
      const ok = await panel.run(binding, [{ text: selectAll(node.schema, node.table, c.type, c.type === 'mssql' ? node.database : ''), start: 0, end: 0 }], { table: { schema: node.schema, table: node.table, database: c.type === 'mssql' ? node.database : '' } });
      if (ok) rating.success();
    } finally { setRunning(-1); }
  });
  reg('selectTop', (node) => {
    const c = store.get(node.conn);
    return newQueryFor(node, `${selectTop(node.schema, node.table, c.type)}\n`);
  });
  reg('exportTable', async (node) => {
    const { c, session } = await nodeSession(node);
    return runExport(deps, session, selectAll(node.schema, node.table, c.type, c.type === 'mssql' ? node.database : ''), node.table);
  });
  reg('copyName', async (node) => {
    const c = store.get(node.conn);
    const name = node.table || node.name ? (node.kind !== 'column' && node.schema ? qualified(node.schema, node.table || node.name, c.type) : (node.table || node.name)) : (node.schema || node.database || node.label);
    await vscode.env.clipboard.writeText(node.kind === 'column' || node.kind === 'index' ? node.name : name);
    vscode.window.setStatusBarMessage(`Copied ${node.kind === 'column' || node.kind === 'index' ? node.name : name}`, 2500);
  });
  reg('showError', (node) => vscode.window.showErrorMessage(node.message, { modal: false }));
  reg('queryHistory', async () => {
    const all = context.globalState.get(HISTORY_KEY, {});
    const items = [];
    for (const c of store.list()) for (const h of all[c.id] || []) items.push({ label: h.sql.replace(/\s+/g, ' ').slice(0, 120), description: `${c.name}${h.db ? ` · ${h.db}` : ''}`, detail: new Date(h.at).toLocaleString(), h, c });
    items.sort((a, b) => b.h.at.localeCompare(a.h.at));
    if (!items.length) { vscode.window.showInformationMessage(settings().history ? 'No queries yet.' : 'The query history is off (setting zovoOra.history).'); return; }
    const p = await vscode.window.showQuickPick(items, { title: 'Query history (kept on this computer)', matchOnDescription: true, matchOnDetail: true });
    if (!p) return;
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.languageId === 'sql') await ed.edit((e) => e.insert(ed.selection.active, `${p.h.sql}${/;\s*$/.test(p.h.sql) ? '' : ';'}\n`));
    else await newQueryFor({ conn: p.c.id, database: p.h.db }, `${p.h.sql}${/;\s*$/.test(p.h.sql) ? '' : ';'}\n`);
  });
  reg('clearHistory', async () => { await context.globalState.update(HISTORY_KEY, {}); vscode.window.showInformationMessage('Query history cleared.'); });
  reg('openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#zovoOra.start`, false));
  reg('scriptCreate', async (node) => {
    if (!node || !node.conn) return;
    const { c, session } = await nodeSession(node);
    const name = node.table || node.name;
    const text = await session.ddl(node.schema, name, node.kind);
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: `-- ${c.name} · ${node.schema}.${name}\n${text}` });
    bind(doc, { conn: c.id, database: node.database || (c.type === 'oracle' ? '' : c.database || ''), schema: node.schema });
    await vscode.window.showTextDocument(doc, { preview: false });
  });
  reg('toggleServerOutput', async () => {
    const ed = vscode.window.activeTextEditor;
    const b = ed && bindingOf(ed.document);
    if (!b || store.get(b.conn).type !== 'oracle') { vscode.window.showInformationMessage('DBMS_OUTPUT is an Oracle feature. Open a .sql file bound to an Oracle connection.'); return; }
    const { session } = await bindingSession(b);
    await session.open();
    await session.enableOutput(!session.serverOutput);
    vscode.window.showInformationMessage(`DBMS_OUTPUT is ${session.serverOutput ? 'on' : 'off'} for this connection until it closes. The setting zovoOra.oracleDbmsOutput sets the default.`);
  });

  // ---------- Pro ----------
  reg('erDiagram', async (node) => {
    const t = await schemaNodePick(node, 'ER diagram of which connection?');
    if (!t) return;
    if (!(await proApi.allow('ER diagram', 'The ER diagram draws the tables of a schema with their keys and foreign-key links, and saves it as SVG.'))) return;
    await pro.showErDiagram(vscode, context, t.session, t.schema, t.label);
  });
  reg('compareSchemas', async (node) => {
    const a = await schemaNodePick(node, 'Compare: first connection');
    if (!a) return;
    const b = await schemaNodePick(null, 'Compare with which connection?');
    if (!b) return;
    if (!(await proApi.allow('Schema compare', 'Schema compare shows the tables, columns, types and keys of two schemas side by side, with the differences marked.'))) return;
    const [ta, tb, fa, fb] = await Promise.all([a.session.schemaColumns(a.schema), b.session.schemaColumns(b.schema), a.session.foreignKeys(a.schema), b.session.foreignKeys(b.schema)]);
    const left = await vscode.workspace.openTextDocument({ language: 'sql', content: pro.schemaText(ta, fa, a.label) });
    const right = await vscode.workspace.openTextDocument({ language: 'sql', content: pro.schemaText(tb, fb, b.label) });
    const sum = pro.schemaDiffSummary(ta, tb);
    await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${a.label} ↔ ${b.label}`);
    vscode.window.showInformationMessage(`${sum.onlyA} tables only in ${a.label}, ${sum.onlyB} only in ${b.label}, ${sum.changed} with different columns.`);
  });
  reg('explainPlan', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'sql') { vscode.window.showInformationMessage('Put the cursor in a query of a .sql file first.'); return; }
    let b = bindingOf(ed.document);
    if (!b) { const c = await pickConnection(); if (!c) return; b = { conn: c.id, database: c.type === 'oracle' ? '' : c.database || '' }; bind(ed.document, b); }
    const c = store.get(b.conn);
    const st = ed.selection.isEmpty ? statementAt(ed.document.getText(), ed.document.offsetAt(ed.selection.active), c.type) : { text: ed.document.getText(ed.selection) };
    if (!st || !st.text.trim()) return;
    if (!(await proApi.allow('Execution plan', 'The execution plan shows how the server will run a query (SQL Server estimated showplan, Oracle EXPLAIN PLAN) as a tree with costs, without running it.'))) return;
    const { session } = await bindingSession(b);
    const plan = await session.explain(st.text, b.database && b.database !== c.database ? b.database : '');
    await pro.showPlan(vscode, context, plan, `Plan: ${st.text.replace(/\s+/g, ' ').slice(0, 40)}`);
  });
  reg('exportSchemaDdl', async (node) => {
    const t = await schemaNodePick(node, 'Export the DDL of which connection?');
    if (!t) return;
    if (!(await proApi.allow('Schema DDL export', 'Schema DDL export writes the CREATE statements of every table, view, procedure, function and package of a schema into one .sql file.'))) return;
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const target = await vscode.window.showSaveDialog({ title: `DDL of ${t.label}`, filters: { SQL: ['sql'] }, defaultUri: folder ? vscode.Uri.joinPath(folder.uri, `${String(t.schema).replace(/[^\w.-]+/g, '_')}-ddl.sql`) : undefined });
    if (!target) return;
    let stop = false;
    const n = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Writing the DDL of ${t.label}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      return pro.exportSchemaDdl(t.session, t.schema, target.fsPath, { shouldStop: () => stop, onProgress: (k, total) => progress.report({ message: `${k} of ${total}` }) });
    });
    const open = await vscode.window.showInformationMessage(`Wrote ${n} CREATE statements to ${path.basename(target.fsPath)}.`, 'Open file');
    if (open) await vscode.commands.executeCommand('vscode.open', target);
  });
  reg('saveQuery', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const sql = (ed.selection.isEmpty ? ed.document.getText() : ed.document.getText(ed.selection)).trim();
    if (!sql) return;
    const name = await vscode.window.showInputBox({ title: 'Save to the query library', prompt: 'A name for this query', value: (sql.split('\n').find((l) => l.trim() && !l.startsWith('--')) || '').slice(0, 60) });
    if (!name) return;
    if (!(await proApi.allow('Query library', 'The query library keeps named queries on this computer and opens them on any connection.'))) return;
    const b = bindingOf(ed.document);
    await pro.saveQuery(context, { name, sql, conn: b ? b.conn : null, database: b ? b.database : '' });
    vscode.window.showInformationMessage(`Saved "${name}" to the query library.`);
  });
  reg('openSavedQuery', async () => {
    const list = pro.savedQueries(context);
    if (!list.length) { vscode.window.showInformationMessage('The query library is empty. Use "Save Query to Library" in a .sql file.'); return; }
    const p = await vscode.window.showQuickPick(list.map((q) => ({ label: q.name, description: q.conn && store.get(q.conn) ? store.get(q.conn).name : '', detail: q.sql.replace(/\s+/g, ' ').slice(0, 140), q, buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' }] })), { title: 'Query library', matchOnDetail: true });
    if (!p) return;
    if (!(await proApi.allow('Query library', 'The query library keeps named queries on this computer and opens them on any connection.'))) return;
    await newQueryFor(p.q.conn && store.get(p.q.conn) ? { conn: p.q.conn, database: p.q.database } : null, p.q.sql + '\n');
  });

  // Close every connection when the window closes.
  context.subscriptions.push({ dispose: () => { sessions.close().catch(() => {}); } });
}

function deactivate() {}

module.exports = { activate, deactivate, settings };

'use strict';
// The results grid: one panel per query file or opened table. Holds the loaded rows in the host (full values),
// sends the grid short cells, and runs Load more, server-side sort and filter, cell view, copy, export and
// row edits. Every change the grid commits is shown as SQL first and runs in one transaction.

const path = require('path');
const crypto = require('crypto');
const { buildHtml } = require('./html');
const { gridRows, toText, isBinary, csvLine, jsonValue } = require('./core/values');
const { editStatements, wrapQuery } = require('./core/dialect');
const { isWrappable } = require('./core/sqlsplit');
const { commandUris, showLinks } = require('./support');
const { exportToFile, FORMATS } = require('./export');

const panels = new Map();
let seq = 0;

class ResultsPanel {
  /** deps: {vscode, context, sessions, store, settings, rating, onRunError, history} */
  static forKey(deps, key, title, column) {
    let p = panels.get(key);
    if (p && !p.disposed) {
      p.panel.title = title;
      if (!p.panel.visible) p.panel.reveal(column, true);
      return p;
    }
    p = new ResultsPanel(deps, key, title, column);
    panels.set(key, p);
    return p;
  }

  static all() { return [...panels.values()].filter((p) => !p.disposed); }

  constructor(deps, key, title, column) {
    const v = deps.vscode;
    this.deps = deps;
    this.key = key;
    this.sets = [];
    this.running = null;
    this.pending = new Map();
    const ctx = deps.context;
    const dist = v.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = v.Uri.joinPath(ctx.extensionUri, 'media');
    this.panel = v.window.createWebviewPanel('zovoOra.results', title, { viewColumn: column, preserveFocus: true }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist, media], enableCommandUris: commandUris('zovoOra'),
    });
    this.panel.iconPath = v.Uri.joinPath(ctx.extensionUri, 'media', 'table.svg');
    this.panel.webview.html = buildHtml({
      cspSource: this.panel.webview.cspSource,
      scriptUri: this.panel.webview.asWebviewUri(v.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: this.panel.webview.asWebviewUri(v.Uri.joinPath(media, 'webview.css')).toString(),
      title, page: 'grid', showSupportLinks: showLinks(v, 'zovoOra'),
    });
    this.ready = false;
    this.queue = [];
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'toast', level: 'error', message: e.message || String(e) })));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      panels.delete(this.key);
      for (const s of this.sets) if (s.handle && !s.handle.done) s.handle.close().catch(() => {});
    });
  }

  post(msg) {
    if (this.disposed) return;
    if (!this.ready) { this.queue.push(msg); return; }
    this.panel.webview.postMessage(msg);
  }

  settings() { return this.deps.settings(); }

  /**
   * Run statements (T-SQL batches or Oracle statements) one after another. Every result set gets a tab;
   * PRINT and DBMS_OUTPUT lines, row counts and errors go to Messages.
   */
  async run(binding, statements, opts = {}) {
    for (const s of this.sets) if (s.handle && !s.handle.done) await s.handle.close().catch(() => {});
    this.sets = [];
    this.messages = [];
    this.post({ type: 'clear' });
    const limit = this.settings().rowLimit;
    if (binding.session.startRun) await binding.session.startRun();
    let ok = true;
    let anyNotice = false;
    const t00 = Date.now();
    outer:
    for (let i = 0; i < statements.length; i++) {
      const st = statements[i];
      const reps = Math.max(1, st.repeat || 1);
      for (let r = 0; r < reps; r++) {
        const t0 = Date.now();
        const msg = { sql: st.text, text: '', ok: true, notices: [] };
        this.running = { session: binding.session };
        this.post({ type: 'running', sql: st.text, n: i + 1 });
        let batch;
        try {
          batch = await binding.session.runBatch(st.text, limit, {
            client: !!st.client,
            onLateSet: (ds) => this.addSet(binding, st, ds, opts, Date.now() - t0),
            onNotice: (t) => { msg.notices.push(t); this.postMessages(); },
          });
        } catch (e) {
          ok = false;
          msg.ok = false;
          msg.text = e.message || String(e);
          if (e.notices) msg.notices.push(...e.notices);
          this.messages.push(msg);
          this.post({ type: 'error', message: e.message || String(e), sql: st.text });
          if (opts.onError) opts.onError(st, e);
          break outer;
        } finally {
          this.running = null;
        }
        const ms = Date.now() - t0;
        for (const ds of batch.sets) this.addSet(binding, st, ds, opts, ms);
        msg.notices.push(...batch.notices);
        if (msg.notices.length) anyNotice = true;
        const parts = [];
        if (batch.sets.length) parts.push(`${batch.sets.length} result${batch.sets.length === 1 ? '' : 's'}`);
        const changed = batch.rowCounts.reduce((a, x) => a + x, 0);
        if (batch.rowCounts.length && !batch.sets.length) parts.push(`${changed.toLocaleString('en-US')} row${changed === 1 ? '' : 's'} affected`);
        if (!parts.length) parts.push(batch.command === 'SQL*Plus' ? 'SQL*Plus command' : 'Done');
        msg.text = `${parts.join(', ')} (${ms} ms)${reps > 1 ? ` · run ${r + 1} of ${reps}` : ''}`;
        msg.ms = ms;
        this.messages.push(msg);
        if (opts.onStatementDone) opts.onStatementDone(st);
      }
    }
    this.lastMs = Date.now() - t00;
    const s0 = binding.session;
    if (opts.onDatabaseChange && s0.homeDb && s0.currentDb && s0.currentDb !== s0.homeDb) opts.onDatabaseChange(s0.currentDb);
    if (statements.length > 1 || anyNotice || !this.sets.length || !ok) this.postMessages();
    this.post({ type: 'idle' }); // the last statement may have had no result set: stop the Running bar
    return ok;
  }

  postMessages() {
    this.post({ type: 'messages', messages: this.messages.map((m) => ({ ...m, notices: m.notices.slice(0, 5000), more: Math.max(0, m.notices.length - 5000) })) });
  }

  /** One result set of a batch becomes a tab. */
  addSet(binding, st, ds, opts, ms) {
    const set = this.newSet(binding, st.text, this.sets.length + 1);
    set.table = opts.table || null;
    set.handle = ds;
    set.columns = ds.columns;
    set.rows = ds.rows;
    set.done = ds.done;
    set.ms = ms;
    set.single = !st.repeat || st.repeat === 1;
    set.k = this.sets.filter((x) => x.sql === st.text).length; // position of this result inside its batch
    set.message = `${ds.rows.length.toLocaleString('en-US')}${ds.done ? '' : '+'} rows in ${ms} ms`;
    this.sets.push(set);
    this.post({ type: 'result', set: this.view(set), fresh: true });
    if (this.sets.length === 1) this.findEditTarget(set);
    return set;
  }

  newSet(binding, sql, n) {
    seq += 1;
    return {
      id: `r${seq}`, n, sql, binding, session: binding.session, dialect: binding.session.dialect,
      columns: [], rows: [], done: true, handle: null, editTarget: null, sort: null, filters: [], server: false,
      readOnly: !!binding.readOnly,
    };
  }

  effectiveSql(set) {
    if (!set.server) return set.sql;
    return wrapQuery(set.sql, set.dialect, set.sort, set.filters.map((f) => ({ name: set.columns[f.col].name, text: f.text })));
  }

  /** Run a set's query again (refresh, server-side sort or filter, after a commit): the first result replaces the tab. */
  async execute(set, sql) {
    const limit = this.settings().rowLimit;
    const t0 = Date.now();
    this.running = set;
    this.post({ type: 'running', id: set.id, sql: set.sql, n: set.n, keep: true });
    let batch;
    try {
      if (set.handle && !set.handle.done) await set.handle.close().catch(() => {});
      batch = await set.session.runBatch(sql, limit, {});
    } finally {
      this.running = null;
    }
    const ds = batch.sets[0];
    if (!ds) throw new Error('The query returned no result this time.');
    for (const extra of batch.sets.slice(1)) extra.close().catch(() => {});
    set.ms = Date.now() - t0;
    set.handle = ds;
    set.columns = ds.columns;
    set.rows = ds.rows;
    set.done = ds.done;
    set.message = `${ds.rows.length.toLocaleString('en-US')}${ds.done ? '' : '+'} rows in ${set.ms} ms`;
    this.post({ type: 'result', set: this.view(set), fresh: false });
    if (set.editTarget) this.post({ type: 'editable', id: set.id, edit: this.editView(set) });
    return set;
  }

  view(set) {
    return {
      id: set.id, n: set.n, sql: set.sql, ms: set.ms, done: set.done, message: set.message,
      columns: set.columns.map((c) => ({ name: c.name, type: c.type, kind: c.kind, binary: !!c.binary })),
      rows: gridRows(set.rows), sort: set.sort, filters: set.filters, server: set.server,
      canServer: set.single !== false && isWrappable(set.sql, set.dialect), maxRows: this.settings().maxLoadedRows,
      table: set.table ? set.table.table : null,
    };
  }

  editView(set) {
    const t = set.editTarget;
    if (!t) return { ok: false, reason: '' };
    if (set.readOnly) return { ok: false, reason: 'This connection is read-only.' };
    if (!t.pk) return { ok: false, reason: t.reason };
    return { ok: true, table: t.table, pk: t.pk, editable: t.editable, insertable: !!t.allColumns };
  }

  async findEditTarget(set) {
    try {
      set.editTarget = await set.session.editTarget(set.columns, set.sql, set.table);
    } catch (e) {
      set.editTarget = { reason: `Could not read the table's key: ${e.message}` };
    }
    this.post({ type: 'editable', id: set.id, edit: this.editView(set) });
  }

  setById(id) {
    const s = this.sets.find((x) => x.id === id);
    if (!s) throw new Error('This result is gone. Run the query again.');
    return s;
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const v = this.deps.vscode;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.panel.webview.postMessage({ type: 'clear' });
        for (const s of this.sets) this.panel.webview.postMessage({ type: 'result', set: this.view(s), fresh: true });
        for (const s of this.sets) if (s.editTarget) this.panel.webview.postMessage({ type: 'editable', id: s.id, edit: this.editView(s) });
        while (this.queue.length) this.panel.webview.postMessage(this.queue.shift());
        return;
      case 'loadMore': return this.loadMore(m.id);
      case 'cancel': return this.cancel();
      case 'sort':
      case 'filter': return this.serverView(m);
      case 'openCell': return this.openCell(m.id, m.row, m.col);
      case 'copy': return this.copy(m.id, m.rows, m.format, m.cols);
      case 'export': return this.exportSet(m.id, m.format);
      case 'edits': return this.review(m.id, m.changes);
      case 'commit': return this.commit(m.id, m.token);
      case 'refresh': {
        const s = this.setById(m.id);
        return this.execute(s, this.effectiveSql(s)).catch((e) => this.post({ type: 'error', id: s.id, message: e.message }));
      }
      case 'openSettings': return v.commands.executeCommand('workbench.action.openSettings', 'zovoOra');
      default:
    }
  }

  async loadMore(id) {
    const s = this.setById(id);
    if (s.done || !s.handle) return;
    const max = this.settings().maxLoadedRows;
    if (s.rows.length >= max) {
      this.post({ type: 'toast', level: 'info', message: `${max.toLocaleString('en-US')} rows are loaded, the limit of zovoOra.maxLoadedRows. Export the result to get every row.` });
      return;
    }
    const n = Math.min(this.settings().rowLimit, max - s.rows.length);
    this.running = s;
    this.post({ type: 'loading', id });
    let more;
    try {
      more = await s.handle.fetchMore(n);
    } catch (e) {
      this.post({ type: 'error', id, message: e.message || String(e) });
      return;
    } finally { this.running = null; }
    const start = s.rows.length;
    for (const r of more) s.rows.push(r);
    s.done = s.handle.done || more.length < n;
    this.post({ type: 'append', id, start, rows: gridRows(more), done: s.done });
  }

  async cancel() {
    const s = this.running;
    if (!s || !s.session) return;
    try {
      const ok = await s.session.cancel();
      if (!ok) this.post({ type: 'toast', level: 'info', message: 'Nothing is running on this connection.' });
    } catch (e) {
      this.post({ type: 'toast', level: 'error', message: `Cancel failed: ${e.message}` });
    }
  }

  async serverView(m) {
    const s = this.setById(m.id);
    if (s.single === false || !isWrappable(s.sql, s.dialect)) {
      this.post({ type: 'toast', level: 'info', message: 'Only a SELECT can be sorted or filtered on the server. The loaded rows are sorted here instead.' });
      return;
    }
    if (m.type === 'sort') s.sort = m.col === null || m.col === undefined ? null : { col: Number(m.col) + 1, desc: !!m.desc };
    if (m.type === 'filter') s.filters = (m.filters || []).filter((f) => f && String(f.text || '') !== '' && s.columns[f.col]).map((f) => ({ col: Number(f.col), text: String(f.text) }));
    const names = s.columns.map((c) => c.name);
    if (s.filters.length && new Set(names).size !== names.length) {
      this.post({ type: 'toast', level: 'info', message: 'Two columns have the same name, so the server cannot filter on one of them. Give them aliases in the SELECT.' });
      s.filters = [];
    }
    s.server = !!(s.sort || s.filters.length);
    if (s.handle && !s.handle.done) await s.handle.close().catch(() => {});
    try {
      await this.execute(s, this.effectiveSql(s));
    } catch (e) {
      this.post({ type: 'error', id: s.id, message: e.message || String(e) });
    }
  }

  async openCell(id, row, col) {
    const v = this.deps.vscode;
    const s = this.setById(id);
    const value = s.rows[row] ? s.rows[row][col] : undefined;
    if (value === undefined) return;
    const c = s.columns[col];
    let content;
    let language = 'plaintext';
    if (value === null) content = 'NULL';
    else if (isBinary(value)) {
      const b = Buffer.from(value);
      const shown = b.subarray(0, 1048576);
      const lines = [`${c.name}: ${b.length.toLocaleString('en-US')} bytes${b.length > shown.length ? ' (first 1 MB shown)' : ''}`, ''];
      for (let i = 0; i < shown.length; i += 16) {
        const part = shown.subarray(i, i + 16);
        lines.push(`${i.toString(16).padStart(8, '0')}  ${[...part].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${[...part].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}`);
      }
      content = lines.join('\n');
    } else {
      content = toText(value);
      if (c.kind === 'json') {
        try { content = JSON.stringify(JSON.parse(content), null, 2); language = 'json'; } catch { /* not JSON */ }
      }
    }
    const doc = await v.workspace.openTextDocument({ content, language });
    await v.window.showTextDocument(doc, { viewColumn: v.ViewColumn.Active, preview: true });
  }

  async copy(id, rows, format, cols) {
    const v = this.deps.vscode;
    const s = this.setById(id);
    const idx = Array.isArray(rows) && rows.length ? rows : s.rows.map((_, i) => i);
    const colIdx = Array.isArray(cols) && cols.length ? cols : s.columns.map((_, i) => i);
    const max = 100000;
    const take = idx.slice(0, max).filter((i) => s.rows[i]);
    const names = colIdx.map((i) => s.columns[i].name);
    const pick = (r) => colIdx.map((i) => r[i]);
    let text;
    if (format === 'json') {
      text = JSON.stringify(take.map((i) => Object.fromEntries(colIdx.map((c) => [s.columns[c].name, jsonValue(s.rows[i][c], s.columns[c].kind)]))), null, 2);
    } else if (format === 'markdown') {
      const esc = (x) => (x === null || x === undefined ? 'NULL' : (isBinary(x) ? `(${x.length} bytes)` : toText(x))).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      text = `| ${names.map(esc).join(' | ')} |\n| ${names.map(() => '---').join(' | ')} |\n` + take.map((i) => `| ${pick(s.rows[i]).map(esc).join(' | ')} |`).join('\n') + '\n';
    } else if (format === 'tsv') {
      text = take.map((i) => pick(s.rows[i]).map((x) => (x === null ? '' : (isBinary(x) ? '' : toText(x).replace(/[\t\r\n]/g, ' ')))).join('\t')).join('\n');
    } else if (format === 'value') {
      const x = s.rows[take[0]][colIdx[0]];
      text = x === null ? 'NULL' : toText(x);
    } else {
      text = csvLine(names) + take.map((i) => csvLine(pick(s.rows[i]))).join('');
    }
    await v.env.clipboard.writeText(text);
    this.post({ type: 'toast', level: 'info', message: format === 'value' ? 'Copied the value.' : `Copied ${take.length.toLocaleString('en-US')} rows as ${format === 'markdown' ? 'Markdown' : (format || 'csv').toUpperCase()}.` });
  }

  async exportSet(id, format) {
    const s = this.setById(id);
    if (s.k > 0) {
      this.post({ type: 'toast', level: 'info', message: 'Export runs the statement again and writes its first result. To export this result, run its SELECT alone, or copy the loaded rows.' });
      return undefined;
    }
    const table = (s.table && s.table.table) || (s.editTarget && s.editTarget.table) || 'query_result';
    return runExport(this.deps, s.session, this.effectiveSql(s), table, format);
  }

  async review(id, changes) {
    const s = this.setById(id);
    const t = s.editTarget;
    if (!t || !t.pk) throw new Error((t && t.reason) || 'This result cannot be edited.');
    if (s.readOnly) throw new Error('This connection is read-only.');
    const colName = (i) => (t.editable[i] ? t.columns[i] : null);
    const keyOf = (row) => {
      const r = s.rows[row];
      if (!r) throw new Error('A changed row is no longer loaded. Refresh and edit again.');
      const key = {};
      for (const k of t.pk) key[k] = r[t.columns.indexOf(k)];
      return key;
    };
    const valuesOf = (vals) => {
      const o = {};
      for (const [c, val] of Object.entries(vals || {})) {
        const name = colName(Number(c));
        if (name) o[name] = val === null ? null : String(val);
      }
      return o;
    };
    const list = [];
    for (const row of changes.deletes || []) list.push({ kind: 'delete', key: keyOf(row) });
    for (const u of changes.updates || []) list.push({ kind: 'update', key: keyOf(u.row), set: valuesOf(u.values) });
    for (const ins of changes.inserts || []) list.push({ kind: 'insert', values: valuesOf(ins.values) });
    const statements = editStatements({ schema: t.schema, table: t.table }, list, s.dialect);
    if (!statements.length) throw new Error('There are no changes to save.');
    const token = crypto.randomBytes(12).toString('hex');
    this.pending.set(id, { token, statements });
    this.post({ type: 'review', id, token, sql: statements.map((x) => x.sql + ';') });
  }

  async commit(id, token) {
    const s = this.setById(id);
    const p = this.pending.get(id);
    if (!p || p.token !== token) throw new Error('These changes were already saved or replaced. Review them again.');
    this.pending.delete(id);
    try {
      await s.session.transaction(p.statements);
    } catch (e) {
      this.post({ type: 'committed', id, ok: false, message: `Nothing was saved. ${e.message}` });
      return;
    }
    if (this.deps.history) this.deps.history(s.binding, p.statements.map((x) => x.sql + ';').join('\n'));
    this.post({ type: 'committed', id, ok: true, message: `Saved ${p.statements.length} change${p.statements.length === 1 ? '' : 's'} in one transaction.` });
    try {
      await this.execute(s, this.effectiveSql(s));
    } catch (e) {
      this.post({ type: 'error', id, message: e.message });
    }
  }
}

/** Pick a format and a file, then stream the query into it with a progress notification. */
async function runExport(deps, session, sql, table, format) {
  const v = deps.vscode;
  let fmt = FORMATS.find((f) => f.id === format);
  if (!fmt) {
    const pick = await v.window.showQuickPick(FORMATS.map((f) => ({ label: f.label, description: f.description, f })), { title: `Export ${table}`, placeHolder: 'Pick a format. Every row is exported, streamed to the file.' });
    if (!pick) return;
    fmt = pick.f;
  }
  const folder = v.workspace.workspaceFolders && v.workspace.workspaceFolders[0];
  const safe = String(table).replace(/[^\w.-]+/g, '_') || 'export';
  const target = await v.window.showSaveDialog({
    title: `Export ${table} as ${fmt.label}`, saveLabel: 'Export',
    defaultUri: folder ? v.Uri.joinPath(folder.uri, `${safe}.${fmt.ext}`) : undefined,
    filters: { [fmt.label]: [fmt.ext] },
  });
  if (!target) return;
  if (target.scheme !== 'file') { v.window.showErrorMessage('Exports are written to a local file. Pick a folder on this computer.'); return; }
  let stop = false;
  const t0 = Date.now();
  try {
    const r = await v.window.withProgress({ location: v.ProgressLocation.Notification, title: `Exporting ${table}`, cancellable: true }, (progress, token) => {
      token.onCancellationRequested(() => { stop = true; });
      let last = 0;
      return exportToFile(session, sql, {
        format: fmt.id, file: target.fsPath, table, dialect: session.dialect, shouldStop: () => stop,
        onProgress: (n) => { progress.report({ message: `${n.toLocaleString('en-US')} rows`, increment: 0 }); last = n; },
      }).then((x) => ({ ...x, last }));
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = `${r.stopped ? 'Stopped after' : 'Exported'} ${r.rows.toLocaleString('en-US')} rows to ${path.basename(target.fsPath)} in ${secs} s.`;
    const open = await v.window.showInformationMessage(msg, 'Open file', 'Show in folder');
    if (open === 'Open file') await v.commands.executeCommand('vscode.open', target);
    if (open === 'Show in folder') await v.commands.executeCommand('revealFileInOS', target);
  } catch (e) {
    v.window.showErrorMessage(`Export failed: ${e.message || e}`);
  }
}

module.exports = { ResultsPanel, runExport };

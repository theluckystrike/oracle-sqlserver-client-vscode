'use strict';
// SQL Server and Azure SQL session with the pure-JS `tedious` driver (MIT).
// `main` runs the user's batches (so DECLARE, temp tables and SET options behave like in other tools); `meta`
// reads the schema for the explorer and commits grid edits. Both open only when the user acts.
// No keep-alive query, no polling: nothing runs while the user does nothing.
//
// runBatch() streams rows: a result stops reading at the row limit (or 64 MB of cell data) and pauses the
// request, so a 1M-row SELECT shows its first page at once and Load more continues it.

const { Connection, Request } = require('tedious');
const { friendlyError, isConnectionLost } = require('./errors');

const NUMBER_TYPES = new Set(['int', 'bigint', 'smallint', 'tinyint', 'intn', 'decimal', 'numeric', 'decimaln', 'numericn', 'float', 'real', 'floatn', 'money', 'smallmoney', 'moneyn']);
const PAGE_BYTES = 64 * 1024 * 1024;

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** SQL Server date and time values as the text SQL Server tools show (UTC parts: tedious runs with useUTC). */
function dateText(d, typeName) {
  if (!(d instanceof Date) || isNaN(d)) return String(d);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const ms = d.getUTCMilliseconds();
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms || /datetime2|datetime$|time/.test(typeName) ? '.' + pad(ms, 3) : ''}`;
  if (typeName === 'date' || typeName === 'daten') return date;
  if (typeName === 'time' || typeName === 'timen') return time;
  if (typeName === 'datetimeoffset' || typeName === 'datetimeoffsetn') return `${date} ${time} +00:00`;
  return `${date} ${time}`;
}

function typeLabel(col) {
  const t = String((col.type && col.type.name) || '').toLowerCase();
  const base = t.replace(/n$/, (m) => (['intn', 'bitn', 'floatn', 'moneyn', 'decimaln', 'numericn', 'datetimen', 'daten', 'timen', 'datetimeoffsetn'].includes(t) ? '' : m));
  if (col.udtInfo && col.udtInfo.typeName) return col.udtInfo.typeName;
  if (/char|binary/.test(base)) return col.dataLength === 65535 || col.dataLength > 8000 || col.dataLength === undefined ? `${base}(max)` : `${base}(${/^n/.test(base) ? col.dataLength / 2 : col.dataLength})`;
  if (base === 'decimal' || base === 'numeric') return `${base}(${col.precision},${col.scale})`;
  if (t === 'intn') return ({ 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' })[col.dataLength] || 'int';
  if (t === 'floatn') return col.dataLength === 4 ? 'real' : 'float';
  if (t === 'moneyn') return col.dataLength === 4 ? 'smallmoney' : 'money';
  return base;
}

function describe(col) {
  const t = String((col.type && col.type.name) || '').toLowerCase();
  return {
    name: col.colName,
    type: typeLabel(col),
    raw: t,
    kind: NUMBER_TYPES.has(t) ? 'number' : (t === 'bit' || t === 'bitn' ? 'bool' : 'text'),
    binary: /binary|image|udt/.test(t) && !(col.udtInfo && /hierarchyid/i.test(col.udtInfo.typeName || '')),
  };
}

function cellValue(v, col) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return dateText(v, col.raw);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return v;
}

function rowBytes(row) {
  let n = 16;
  for (const v of row) {
    if (typeof v === 'string') n += v.length * 2;
    else if (v && v.length !== undefined) n += v.length;
    else n += 8;
  }
  return n;
}

class MssqlSession {
  /**
   * cfg: {host, port, instance, database, auth: 'sql'|'ntlm'|'token', user, domain, encrypt: 'yes'|'no'|'strict',
   *       trustServerCertificate, readOnly, connectTimeoutMs}
   * secret: password, or the access token for auth 'token'
   */
  constructor(cfg, secret) {
    this.cfg = cfg;
    this.secret = secret;
    this.dialect = 'mssql';
    this.main = null;
    this.meta = null;
    this.active = null; // the open (paused) request on main
    this.onDrop = null;
    this.chain = Promise.resolve(); // requests on main run one after another
  }

  connectionConfig() {
    const c = this.cfg;
    let authentication;
    if (c.auth === 'ntlm') authentication = { type: 'ntlm', options: { userName: c.user || '', password: this.secret || '', domain: c.domain || '' } };
    else if (c.auth === 'token') authentication = { type: 'azure-active-directory-access-token', options: { token: this.secret || '' } };
    else authentication = { type: 'default', options: { userName: c.user || '', password: this.secret || '' } };
    const encrypt = c.encrypt === 'strict' ? 'strict' : c.encrypt !== 'no';
    const options = {
      database: c.database || undefined,
      encrypt,
      trustServerCertificate: !!c.trustServerCertificate,
      connectTimeout: c.connectTimeoutMs || 10000,
      requestTimeout: 0,
      cancelTimeout: 5000,
      appName: 'Zovo SQL Server Client (VS Code)',
      rowCollectionOnDone: false,
      rowCollectionOnRequestCompletion: false,
      useColumnNames: false,
      useUTC: true,
      readOnlyIntent: !!c.readOnly,
      textsize: 2147483647,
    };
    if (c.instance) options.instanceName = c.instance; else options.port = Number(c.port) || 1433;
    return { server: c.host, authentication, options };
  }

  connectClient(role) {
    return new Promise((resolve, reject) => {
      let conn;
      try {
        conn = new Connection(this.connectionConfig());
      } catch (e) {
        reject(friendlyError(e, this.cfg, 'mssql'));
        return;
      }
      let ready = false;
      conn.on('error', (e) => { if (ready) this.dropped(role, conn, e); });
      conn.on('end', () => { if (ready) this.dropped(role, conn, Object.assign(new Error('Connection lost: the server closed the connection.'), { code: 'ESOCKET' })); });
      conn.connect((err) => {
        if (err) { try { conn.close(); } catch { /* closed */ } reject(friendlyError(err, this.cfg, 'mssql')); return; }
        ready = true;
        resolve(conn);
      });
    });
  }

  dropped(role, conn, e) {
    if (conn._zovoClosing) return;
    let mine = false;
    if (role === 'main' && this.main === conn) { this.main = null; mine = true; }
    if (role === 'meta' && this.meta === conn) { this.meta = null; mine = true; }
    if (conn._zovoLost) return;
    conn._zovoLost = e || new Error('Connection lost');
    if (role === 'main' && this.active && this.active.lost) this.active.lost(conn._zovoLost);
    if (mine && this.onDrop) this.onDrop(role, friendlyError(Object.assign(e || {}, { code: (e && e.code) || 'ESOCKET' }), this.cfg, 'mssql'));
  }

  async open() {
    if (!this.main) {
      this.main = await this.connectClient('main');
      const r = await this.simple(this.main, "SELECT @@VERSION AS v, DB_NAME() AS db, SUSER_SNAME() AS u, CAST(SERVERPROPERTY('EngineEdition') AS int) AS ed, @@SPID AS spid");
      const row = r[0] || {};
      this.info = { version: String(row.v || '').split('\n')[0].trim(), database: row.db, user: row.u, edition: row.ed };
      this.spid = row.spid;
      this.homeDb = row.db || '';
      this.currentDb = row.db || '';
      this.main.on('databaseChange', (name) => { if (name) this.currentDb = name; });
    }
    return this.info;
  }

  async metaClient() {
    if (!this.meta) this.meta = await this.connectClient('meta');
    return this.meta;
  }

  /** Run one statement and collect its rows as objects (schema queries; small results only). */
  simple(conn, sql, params) {
    return new Promise((resolve, reject) => {
      const rows = [];
      let cols = null;
      const req = new Request(sql, (err) => (err ? reject(friendlyError(err, this.cfg, 'mssql', sql)) : resolve(rows)));
      for (const [name, p] of Object.entries(params || {})) req.addParameter(name, p.type, p.value);
      req.on('columnMetadata', (c) => { cols = c.map(describe); });
      req.on('row', (columns) => {
        const o = {};
        columns.forEach((x, i) => { o[cols[i].name] = cellValue(x.value, cols[i]); });
        rows.push(o);
      });
      try {
        if (params) conn.execSql(req); else conn.execSqlBatch(req);
      } catch (e) { reject(friendlyError(e, this.cfg, 'mssql', sql)); }
    });
  }

  async metaQuery(sql, params) {
    try {
      return await this.simple(await this.metaClient(), sql, params);
    } catch (e) {
      if (isConnectionLost(e)) { this.meta = null; return this.simple(await this.metaClient(), sql, params); }
      throw e;
    }
  }

  /**
   * Called before each run from an editor or the explorer: a USE in an earlier run left this shared session in
   * another database, so go back to the session's own database first. Batches of one run keep the USE.
   */
  async startRun() {
    if (!this.main || !this.homeDb || !this.currentDb || this.currentDb === this.homeDb) return;
    await this.closeActive();
    await this.idle();
    try {
      await this.simple(this.main, `USE [${String(this.homeDb).replace(/]/g, ']]')}]`);
      this.currentDb = this.homeDb;
    } catch { /* the next batch reports any real problem */ }
  }

  async closeActive() {
    const a = this.active;
    this.active = null;
    if (a) await a.close();
  }

  /** Wait for the queue of requests on main (a read-only rollback may still run). */
  async idle() {
    await this.chain.catch(() => {});
  }

  /**
   * Run one T-SQL batch on main.
   * @returns {Promise<{sets, notices, rowCounts, command}>} sets: [{columns, rows, done, fetchMore(n), close()}].
   * hooks.onLateSet(set) and hooks.onNotice(text) report sets and messages that arrive after the first page.
   */
  async runBatch(sql, maxRows, hooks = {}) {
    await this.closeActive();
    await this.idle();
    let retried = false;
    for (;;) {
      try {
        await this.open();
        return await this.execBatch(sql, maxRows, hooks);
      } catch (e) {
        // A connection that died while idle (server restart, VPN drop): reconnect once and run again, but only
        // when nothing reached the server, which is the case when the socket was already gone.
        if (!retried && e.beforeSend && isConnectionLost(e)) {
          retried = true;
          this.main = null;
          if (hooks.onNotice) hooks.onNotice('The connection was lost. Reconnected and ran the batch again.');
          continue;
        }
        throw e;
      }
    }
  }

  async execBatch(sql, maxRows, hooks) {
    const conn = this.main;
    if (this.cfg.readOnly) await this.simple(conn, 'SET IMPLICIT_TRANSACTIONS OFF; BEGIN TRANSACTION;').catch((e) => { e.beforeSend = true; throw e; });
    return new Promise((resolve, reject) => {
      const sets = [];
      const notices = [];
      const rowCounts = [];
      let cur = null; // set being read
      let settled = false;
      let ended = false;
      let failed = null;
      let paused = false;
      let want = maxRows;
      let bytes = 0;
      let waiter = null;
      const batch = { sets, notices, rowCounts, command: (/^\s*([A-Za-z]+)/.exec(sql.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, '')) || [])[1] || 'Batch' };

      const onInfo = (info) => {
        const text = info.message;
        if (notices.length < 20000) notices.push(text);
        if (settled && hooks.onNotice) hooks.onNotice(text);
      };
      conn.on('infoMessage', onInfo);

      const newSet = (meta) => {
        const columns = meta.map(describe);
        const set = {
          columns, rows: [], buf: [], done: false, ended: false,
          fetchMore: (n) => new Promise((ok, bad) => {
            if (set.ended && !set.buf.length) { set.done = true; ok([]); return; }
            if (failed && !set.buf.length) { set.done = true; bad(failed); return; }
            want = n;
            bytes = set.buf.reduce((a, r) => a + rowBytes(r), 0);
            const finish = () => {
              const out = set.buf.splice(0, n);
              if (set.ended && !set.buf.length) set.done = true;
              ok(out);
            };
            if (set.buf.length >= n || set.ended || ended) { finish(); return; }
            waiter = { set, finish, bad };
            if (paused) { paused = false; req.resume(); }
          }),
          close: () => closeAll(),
        };
        return set;
      };

      const settle = () => {
        if (settled) return;
        settled = true;
        for (const s of sets) {
          s.rows = s.buf.splice(0, maxRows);
          s.done = s.ended && !s.buf.length;
        }
        if (!ended) this.active = handle;
        resolve(batch);
      };

      const closeAll = () => new Promise((ok) => {
        if (ended) { for (const s of sets) { s.done = true; s.buf.length = 0; } ok(); return; }
        for (const s of sets) s.done = true;
        doneWaiters.push(ok);
        try { conn.cancel(); } catch { /* gone */ }
        if (paused) { paused = false; req.resume(); }
      });
      const doneWaiters = [];
      const handle = {
        close: closeAll,
        lost: (e) => {
          failed = friendlyError(e, this.cfg, 'mssql', sql);
          ended = true;
          if (waiter) { const w = waiter; waiter = null; w.set.done = true; w.bad(failed); }
          if (!settled) { settled = true; reject(failed); }
          while (doneWaiters.length) doneWaiters.shift()();
          requestDone();
        },
      };

      let requestDone;
      const inflight = new Promise((r) => { requestDone = r; });
      this.inflight = inflight;
      const req = new Request(sql, (err) => {
        ended = true;
        setImmediate(() => { requestDone(); if (this.inflight === inflight) this.inflight = null; });
        conn.removeListener('infoMessage', onInfo);
        if (cur) cur.ended = true;
        for (const s of sets) s.ended = true;
        if (this.active === handle) this.active = null;
        const finishAll = () => {
          while (doneWaiters.length) doneWaiters.shift()();
          if (err && !/cancel/i.test(err.code || '') && !(err.code === 'ECANCEL')) {
            failed = friendlyError(err, this.cfg, 'mssql', sql);
            if (!settled) { settled = true; reject(failed); return; }
            if (hooks.onNotice) hooks.onNotice(failed.message);
          } else if (err && !settled) {
            settled = true;
            reject(friendlyError(err, this.cfg, 'mssql', sql));
            return;
          }
          if (waiter) { const w = waiter; waiter = null; w.finish(); }
          settle();
        };
        if (this.cfg.readOnly && this.main === conn) {
          // Server-side guard of the read-only switch: whatever the batch changed is rolled back.
          this.chain = this.simple(conn, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;').catch(() => {});
          this.chain.then(finishAll);
        } else finishAll();
      });
      req.on('columnMetadata', (meta) => {
        if (cur) cur.ended = true;
        cur = newSet(meta);
        sets.push(cur);
        bytes = 0;
        if (settled && hooks.onLateSet) hooks.onLateSet(cur);
      });
      req.on('row', (columns) => {
        if (!cur || (cur.done && settled)) return; // closed while rows were on the way: drain them
        const row = columns.map((x, i) => cellValue(x.value, cur.columns[i]));
        cur.buf.push(row);
        bytes += rowBytes(row);
        const full = cur.buf.length >= want || (bytes >= PAGE_BYTES && cur.buf.length > 0);
        if (!settled && full) {
          want = cur.buf.length;
          paused = true; req.pause(); settle(); return;
        }
        if (waiter && waiter.set === cur && full) { paused = true; req.pause(); const w = waiter; waiter = null; w.finish(); }
      });
      // A DONE token after the rows of a result ends that result. Any other DONE with a count is a write.
      const onDone = (rowCount) => {
        if (cur && !cur.ended) {
          cur.ended = true;
          if (waiter && waiter.set === cur) { const w = waiter; waiter = null; w.finish(); }
          return;
        }
        if (rowCount !== undefined && rowCount !== null) {
          rowCounts.push(rowCount);
          const t = `(${rowCount} row${rowCount === 1 ? '' : 's'} affected)`;
          if (notices.length < 20000) notices.push(t);
          if (settled && hooks.onNotice) hooks.onNotice(t);
        }
      };
      req.on('done', onDone);
      req.on('doneInProc', onDone);
      req.on('doneProc', () => {});
      try {
        conn.execSqlBatch(req);
      } catch (e) {
        conn.removeListener('infoMessage', onInfo);
        requestDone();
        const f = friendlyError(e, this.cfg, 'mssql', sql);
        f.beforeSend = true;
        reject(f);
      }
    });
  }

  /** Stop the running batch (TDS attention). */
  async cancel() {
    if (!this.main) return false;
    try { this.main.cancel(); } catch { return false; }
    return true;
  }

  /** Table and key for a result opened from the explorer (SELECT * of one table), or a reason why not. */
  async editTarget(columns, sql, table) {
    if (!columns.length) return { reason: 'This result has no columns.' };
    if (!table || !table.table) return { reason: 'Open a table from the explorer to edit its rows. Query results are read-only.' };
    const name = `[${String(table.schema || 'dbo').replace(/]/g, ']]')}].[${String(table.table).replace(/]/g, ']]')}]`;
    const t = await this.metaQuery(`SELECT o.type AS type FROM ${this.dbPrefix(table.database)}sys.objects o WHERE o.object_id = OBJECT_ID(${lit(this.dbPrefix(table.database) + name)})`);
    if (!t.length) return { reason: 'The source table was not found.' };
    if (String(t[0].type).trim() === 'V') return { reason: `${table.table} is a view, so its rows are read-only here.` };
    const cols = await this.metaQuery(`SELECT c.name AS name, c.is_identity AS ident, c.is_computed AS comp, c.system_type_id AS st,
        CASE WHEN EXISTS (SELECT 1 FROM ${this.dbPrefix(table.database)}sys.index_columns ic JOIN ${this.dbPrefix(table.database)}sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
      FROM ${this.dbPrefix(table.database)}sys.columns c WHERE c.object_id = OBJECT_ID(${lit(this.dbPrefix(table.database) + name)}) ORDER BY c.column_id`);
    const pk = cols.filter((c) => Number(c.pk) === 1).map((c) => c.name);
    if (!pk.length) return { reason: `${table.table} has no primary key, so the grid cannot tell rows apart. It stays read-only.`, schema: table.schema, table: table.table };
    const byName = new Map(cols.map((c) => [c.name, c]));
    const colNames = columns.map((c) => (byName.has(c.name) ? c.name : null));
    const editable = columns.map((c, i) => {
      const x = byName.get(colNames[i]);
      return !!x && !c.binary && Number(x.ident) !== 1 && Number(x.comp) !== 1 && Number(x.st) !== 189;
    });
    return { schema: table.schema, table: table.table, database: table.database, pk, columns: colNames, editable, allColumns: cols.map((c) => ({ name: c.name })) };
  }

  dbPrefix(db) {
    return db ? `[${String(db).replace(/]/g, ']]')}].` : '';
  }

  /** Run the statements in one transaction on the meta connection. Each must change exactly `expect` rows. */
  async transaction(statements) {
    const c = await this.metaClient();
    const run = (sql) => new Promise((resolve, reject) => {
      let count = 0;
      const req = new Request(sql, (err, rc) => (err ? reject(friendlyError(err, this.cfg, 'mssql', sql)) : resolve(rc !== undefined ? rc : count)));
      req.on('done', (rc) => { if (rc !== undefined) count = rc; });
      c.execSqlBatch(req);
    });
    await run(`SET XACT_ABORT ON; BEGIN TRANSACTION;`);
    const done = [];
    try {
      for (const st of statements) {
        const n = await run(`SET NOCOUNT OFF; ${st.sql};`);
        if (st.expect !== undefined && n !== st.expect) throw Object.assign(new Error(`"${st.sql.slice(0, 120)}" changed ${n} rows instead of ${st.expect}. Nothing was saved.`), { friendly: true });
        done.push(n);
      }
      await run('COMMIT TRANSACTION;');
      return done;
    } catch (e) {
      try { await run('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;'); } catch { /* connection gone */ }
      throw friendlyError(e, this.cfg, 'mssql');
    }
  }

  /**
   * Stream a query to onBatch(columns, rows) in batches, on its own connection so the editor stays free.
   * onBatch may return a promise (back-pressure); shouldStop() ends early.
   */
  async exportQuery(sql, onBatch, shouldStop, batchSize = 5000) {
    const conn = await this.connectClient('export');
    try {
      if (this.cfg.readOnly) await this.simple(conn, 'BEGIN TRANSACTION;');
      return await new Promise((resolve, reject) => {
        let columns = null;
        let rows = [];
        let bytes = 0;
        let total = 0;
        let stopping = false;
        let pending = Promise.resolve();
        const flush = (req) => {
          if (!rows.length) return;
          const out = rows;
          rows = [];
          bytes = 0;
          total += out.length;
          req.pause();
          pending = pending.then(() => onBatch(columns, out)).then(() => {
            if (shouldStop && shouldStop()) { stopping = true; conn.cancel(); }
            req.resume();
          }, (e) => { stopping = true; conn.cancel(); reject(e); });
        };
        const req = new Request(sql, (err) => {
          pending.then(async () => {
            if (rows.length) { const out = rows; rows = []; total += out.length; await onBatch(columns, out); }
            if (err && !stopping) reject(friendlyError(err, this.cfg, 'mssql', sql));
            else resolve({ rows: total, columns: columns || [] });
          }, reject);
        });
        req.on('columnMetadata', (meta) => {
          if (columns) { flush(req); stopping = true; conn.cancel(); return; } // export the first result only
          columns = meta.map(describe);
        });
        req.on('row', (cols) => {
          if (stopping) return;
          const row = cols.map((x, i) => cellValue(x.value, columns[i]));
          rows.push(row);
          bytes += rowBytes(row);
          if (rows.length >= batchSize || bytes >= 32 * 1024 * 1024) flush(req);
        });
        conn.execSqlBatch(req);
      });
    } finally {
      conn._zovoClosing = true;
      try { conn.close(); } catch { /* closed */ }
    }
  }

  // ---------- schema for the explorer, autocomplete, ER diagram and schema compare ----------

  async databases() {
    const r = await this.metaQuery('SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 AND state = 0 ORDER BY CASE WHEN database_id > 4 THEN 0 ELSE 1 END, name');
    return r.map((x) => x.name);
  }

  async schemas(db) {
    const p = this.dbPrefix(db);
    const r = await this.metaQuery(`SELECT s.name AS name, (SELECT COUNT(*) FROM ${p}sys.objects o WHERE o.schema_id = s.schema_id AND o.type IN ('U','V') AND o.is_ms_shipped = 0) AS n
      FROM ${p}sys.schemas s WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND s.name NOT LIKE 'db[_]%'
      ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name`);
    return r.map((x) => ({ name: x.name, count: Number(x.n) }));
  }

  async tables(schema, db) {
    const p = this.dbPrefix(db);
    const r = await this.metaQuery(`SELECT o.name AS name, o.type AS type,
        (SELECT SUM(ps.row_count) FROM ${p}sys.dm_db_partition_stats ps WHERE ps.object_id = o.object_id AND ps.index_id IN (0,1)) AS est
      FROM ${p}sys.objects o JOIN ${p}sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @schema AND o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY o.name`, { schema: str(schema) })
      .catch(() => this.metaQuery(`SELECT o.name AS name, o.type AS type, NULL AS est FROM ${p}sys.objects o JOIN ${p}sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY o.name`, { schema: str(schema) }));
    return r.map((x) => ({ name: x.name, kind: String(x.type).trim() === 'V' ? 'view' : 'table', rows: x.est === null || x.est === undefined ? null : Number(x.est) }));
  }

  /** Procedures and functions of a schema. */
  async routines(schema, db) {
    const p = this.dbPrefix(db);
    const r = await this.metaQuery(`SELECT o.name AS name, o.type AS type FROM ${p}sys.objects o JOIN ${p}sys.schemas s ON s.schema_id = o.schema_id
      WHERE s.name = @schema AND o.type IN ('P','FN','IF','TF','PC','FS','FT') AND o.is_ms_shipped = 0 ORDER BY o.name`, { schema: str(schema) });
    return r.map((x) => ({ name: x.name, kind: String(x.type).trim() === 'P' || String(x.type).trim() === 'PC' ? 'procedure' : 'function' }));
  }

  async columns(schema, table, db) {
    const p = this.dbPrefix(db);
    const r = await this.metaQuery(`SELECT c.name AS name, TYPE_NAME(c.user_type_id) AS type, c.max_length AS len, c.precision AS prec, c.scale AS scale,
        c.is_nullable AS nullable, OBJECT_DEFINITION(c.default_object_id) AS dflt, c.is_identity AS ident,
        CASE WHEN EXISTS (SELECT 1 FROM ${p}sys.index_columns ic JOIN ${p}sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
      FROM ${p}sys.columns c WHERE c.object_id = OBJECT_ID(@obj) ORDER BY c.column_id`, { obj: str(`${p}[${String(schema).replace(/]/g, ']]')}].[${String(table).replace(/]/g, ']]')}]`) });
    return r.map((x) => ({ name: x.name, type: sqlType(x), notNull: Number(x.nullable) === 0 || x.nullable === false, default: x.dflt, pk: Number(x.pk) === 1, identity: Number(x.ident) === 1 || x.ident === true }));
  }

  async indexes(schema, table, db) {
    const p = this.dbPrefix(db);
    const r = await this.metaQuery(`SELECT i.name AS name, i.is_primary_key AS pk, i.is_unique AS uniq, i.type_desc AS kind,
        STUFF((SELECT ', ' + c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END FROM ${p}sys.index_columns ic JOIN ${p}sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS cols
      FROM ${p}sys.indexes i WHERE i.object_id = OBJECT_ID(@obj) AND i.type > 0 ORDER BY i.name`, { obj: str(`${p}[${String(schema).replace(/]/g, ']]')}].[${String(table).replace(/]/g, ']]')}]`) });
    return r.map((x) => ({ name: x.name, def: `${String(x.kind).toLowerCase()} (${x.cols})`, pk: x.pk === true || Number(x.pk) === 1, unique: x.uniq === true || Number(x.uniq) === 1 }));
  }

  /** Every column of every table in a schema, for autocomplete, the ER diagram and schema compare. */
  async schemaColumns(schema, limit = 20000, db) {
    const p = this.dbPrefix(db);
    const r = await this.metaQuery(`SELECT TOP (@lim) o.name AS t, o.type AS k, c.name AS c, TYPE_NAME(c.user_type_id) AS type, c.max_length AS len, c.precision AS prec, c.scale AS scale,
        c.is_nullable AS nullable, OBJECT_DEFINITION(c.default_object_id) AS dflt,
        CASE WHEN EXISTS (SELECT 1 FROM ${p}sys.index_columns ic JOIN ${p}sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
      FROM ${p}sys.objects o JOIN ${p}sys.schemas s ON s.schema_id = o.schema_id JOIN ${p}sys.columns c ON c.object_id = o.object_id
      WHERE s.name = @schema AND o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY o.name, c.column_id`, { schema: str(schema), lim: int(limit) });
    return groupColumns(r.map((x) => ({ table: x.t, kind: String(x.k).trim() === 'V' ? 'view' : 'table', name: x.c, type: sqlType(x), notNull: Number(x.nullable) === 0 || x.nullable === false, default: x.dflt, pk: Number(x.pk) === 1 })));
  }

  async foreignKeys(schema, db) {
    const p = this.dbPrefix(db);
    const r = await this.metaQuery(`SELECT fk.name AS name, tp.name AS t, sr.name AS fschema, tr.name AS ft,
        STUFF((SELECT ',' + cp.name FROM ${p}sys.foreign_key_columns k JOIN ${p}sys.columns cp ON cp.object_id = k.parent_object_id AND cp.column_id = k.parent_column_id WHERE k.constraint_object_id = fk.object_id ORDER BY k.constraint_column_id FOR XML PATH('')), 1, 1, '') AS cols,
        STUFF((SELECT ',' + cr.name FROM ${p}sys.foreign_key_columns k JOIN ${p}sys.columns cr ON cr.object_id = k.referenced_object_id AND cr.column_id = k.referenced_column_id WHERE k.constraint_object_id = fk.object_id ORDER BY k.constraint_column_id FOR XML PATH('')), 1, 1, '') AS fcols
      FROM ${p}sys.foreign_keys fk JOIN ${p}sys.tables tp ON tp.object_id = fk.parent_object_id JOIN ${p}sys.schemas sp ON sp.schema_id = tp.schema_id
      JOIN ${p}sys.tables tr ON tr.object_id = fk.referenced_object_id JOIN ${p}sys.schemas sr ON sr.schema_id = tr.schema_id
      WHERE sp.name = @schema ORDER BY tp.name, fk.name`, { schema: str(schema) });
    return r.map((x) => ({ name: x.name, table: x.t, columns: String(x.cols || '').split(','), refSchema: x.fschema, refTable: x.ft, refColumns: String(x.fcols || '').split(',') }));
  }

  /** CREATE text of a view, procedure or function (sys.sql_modules), or a CREATE TABLE built from the catalog. */
  async ddl(schema, name, kind, db) {
    const p = this.dbPrefix(db);
    const obj = `${p}[${String(schema).replace(/]/g, ']]')}].[${String(name).replace(/]/g, ']]')}]`;
    if (kind !== 'table') {
      const r = await this.metaQuery(`SELECT OBJECT_DEFINITION(OBJECT_ID(@obj)) AS def`, { obj: str(obj) });
      if (r[0] && r[0].def) return `${String(r[0].def).trim()}\nGO\n`;
      return `-- The definition of ${schema}.${name} is not readable (encrypted, or no VIEW DEFINITION permission).\n`;
    }
    const cols = await this.columns(schema, name, db);
    const idx = await this.indexes(schema, name, db);
    const fks = (await this.foreignKeys(schema, db)).filter((f) => f.table === name);
    const q = (x) => `[${String(x).replace(/]/g, ']]')}]`;
    const lines = cols.map((c) => `  ${q(c.name)} ${c.type}${c.identity ? ' IDENTITY' : ''}${c.notNull ? ' NOT NULL' : ' NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`);
    const pk = cols.filter((c) => c.pk).map((c) => q(c.name));
    if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
    for (const f of fks) lines.push(`  CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${q(f.refSchema)}.${q(f.refTable)} (${f.refColumns.map(q).join(', ')})`);
    let out = `CREATE TABLE ${q(schema)}.${q(name)} (\n${lines.join(',\n')}\n);\n`;
    for (const i of idx.filter((x) => !x.pk)) out += `-- index ${i.name}: ${i.unique ? 'unique ' : ''}${i.def}\n`;
    return out + 'GO\n';
  }

  /** Estimated plan as showplan XML (Pro). Runs SET SHOWPLAN_XML on the meta connection; the query does not run. */
  async explain(sql, db) {
    const c = await this.metaClient();
    if (db) await this.simple(c, `USE [${String(db).replace(/]/g, ']]')}];`);
    await this.simple(c, 'SET SHOWPLAN_XML ON;');
    try {
      const r = await new Promise((resolve, reject) => {
        const out = [];
        const req = new Request(sql, (err) => (err ? reject(friendlyError(err, this.cfg, 'mssql', sql)) : resolve(out)));
        req.on('row', (cols) => out.push(String(cols[0].value)));
        c.execSqlBatch(req);
      });
      return { format: 'showplan', text: r.join('\n') };
    } finally {
      await this.simple(c, 'SET SHOWPLAN_XML OFF;').catch(() => {});
    }
  }

  async close() {
    // Let a request that is still in flight end first (cancel it if it is paused): closing the socket while the
    // last message of a request is being parsed makes tedious throw outside any callback.
    const wait = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 3000))]);
    await wait(this.closeActive().catch(() => {}));
    if (this.inflight) await wait(this.inflight);
    const all = [this.main, this.meta].filter(Boolean);
    this.main = null; this.meta = null; this.active = null;
    for (const c of all) { c._zovoClosing = true; try { c.close(); } catch { /* closed */ } }
  }
}

const { TYPES } = require('tedious');
function str(v) { return { type: TYPES.NVarChar, value: String(v) }; }
function int(v) { return { type: TYPES.Int, value: Number(v) }; }
function lit(s) { return "N'" + String(s).replace(/'/g, "''") + "'"; }

function sqlType(x) {
  const t = String(x.type || '').toLowerCase();
  const len = Number(x.len);
  if (/^(n?varchar|n?char|varbinary|binary)$/.test(t)) return len === -1 ? `${t}(max)` : `${t}(${/^n/.test(t) ? len / 2 : len})`;
  if (t === 'decimal' || t === 'numeric') return `${t}(${x.prec},${x.scale})`;
  if ((t === 'datetime2' || t === 'time' || t === 'datetimeoffset') && x.scale !== undefined && Number(x.scale) !== 7) return `${t}(${x.scale})`;
  return t;
}

function groupColumns(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table)) map.set(r.table, { name: r.table, kind: r.kind, columns: [] });
    map.get(r.table).columns.push({ name: r.name, type: r.type, notNull: r.notNull, default: r.default == null ? null : String(r.default), pk: r.pk });
  }
  return [...map.values()];
}

module.exports = { MssqlSession, groupColumns, dateText, describe, typeLabel };

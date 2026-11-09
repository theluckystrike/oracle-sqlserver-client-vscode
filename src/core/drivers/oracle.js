'use strict';
// Oracle Database session with node-oracledb in Thin mode (Apache-2.0 OR UPL-1.0): pure JavaScript, no Oracle
// Client libraries, no native module. Easy Connect strings, tnsnames.ora aliases (TNS_ADMIN or a chosen folder)
// and wallets (ewallet.pem) for Autonomous Database.
// `main` runs the user's statements, `meta` reads the schema for the explorer and commits grid edits.
// No keep-alive, no polling, no connection on startup.

const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');
const { friendlyError, isConnectionLost } = require('./errors');

const PAGE_BYTES = 64 * 1024 * 1024;
const T = oracledb;

const NUMBER_TYPES = new Set([T.DB_TYPE_NUMBER, T.DB_TYPE_BINARY_FLOAT, T.DB_TYPE_BINARY_DOUBLE, T.DB_TYPE_BINARY_INTEGER].filter(Boolean));
// Dates stay Date objects (Thin mode builds them in local time) and are written as YYYY-MM-DD HH:MI:SS below.
// INTERVAL columns cannot be fetched as strings (NJS-119 failed the whole query); cellValue writes them as Oracle text.
const AS_STRING = new Set([T.DB_TYPE_NUMBER,
  T.DB_TYPE_CLOB, T.DB_TYPE_NCLOB, T.DB_TYPE_ROWID, T.DB_TYPE_UROWID, T.DB_TYPE_BINARY_FLOAT, T.DB_TYPE_BINARY_DOUBLE].filter(Boolean));
const AS_BUFFER = new Set([T.DB_TYPE_BLOB, T.DB_TYPE_BFILE].filter(Boolean));

/** Exact text for numbers and dates (no float rounding), whole CLOB text, BLOB bytes. */
function fetchTypeHandler(meta) {
  if (AS_STRING.has(meta.dbType)) return { type: T.STRING };
  if (AS_BUFFER.has(meta.dbType) && meta.dbType !== T.DB_TYPE_BFILE) return { type: T.BUFFER };
  return undefined;
}

function describe(m) {
  const tn = String(m.dbTypeName || '').toLowerCase();
  let type = tn;
  if (tn === 'number' && m.precision) type = m.scale ? `number(${m.precision},${m.scale})` : `number(${m.precision})`;
  else if (/char/.test(tn) && m.byteSize) type = `${tn}(${m.byteSize})`;
  return {
    name: m.name,
    type,
    kind: NUMBER_TYPES.has(m.dbType) ? 'number' : (m.dbType === T.DB_TYPE_JSON || tn === 'json' ? 'json' : (tn === 'boolean' ? 'bool' : 'text')),
    binary: m.dbType === T.DB_TYPE_BLOB || m.dbType === T.DB_TYPE_RAW || m.dbType === T.DB_TYPE_LONG_RAW,
    lob: m.dbType === T.DB_TYPE_CLOB || m.dbType === T.DB_TYPE_NCLOB || m.dbType === T.DB_TYPE_BLOB,
  };
}

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) {
    if (isNaN(v)) return String(v);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const ms = v.getMilliseconds();
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}${ms ? `.${p(ms, 3)}` : ''}`;
  }
  if (Buffer.isBuffer(v) || typeof v === 'string' || typeof v === 'number') return v;
  if (ArrayBuffer.isView(v)) return `[${Array.from(v).join(', ')}]`; // VECTOR
  if (v && typeof v.getData === 'function') return '(BFILE)';
  if (T.IntervalDS && v instanceof T.IntervalDS) return intervalText(v);
  if (T.IntervalYM && v instanceof T.IntervalYM) return intervalText(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Oracle text for INTERVAL DAY TO SECOND (+3 04:05:06.7) and INTERVAL YEAR TO MONTH (+1-02). */
function intervalText(v) {
  const p = (n) => String(Math.abs(n || 0)).padStart(2, '0');
  if ('years' in v || 'months' in v) {
    const neg = (v.years || 0) < 0 || (v.months || 0) < 0;
    return `${neg ? '-' : '+'}${Math.abs(v.years || 0)}-${p(v.months)}`;
  }
  const parts = [v.days, v.hours, v.minutes, v.seconds, v.fseconds];
  const neg = parts.some((x) => (x || 0) < 0);
  const ns = Math.abs(v.fseconds || 0);
  const frac = ns ? '.' + String(ns).padStart(9, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : '+'}${Math.abs(v.days || 0)} ${p(v.hours)}:${p(v.minutes)}:${p(v.seconds)}${frac}`;
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

/** Read up to n rows from a result set, but stop early at `budget` bytes of cell data (keeps 10 MB CLOBs safe). */
async function readRows(rs, n, budget = PAGE_BYTES) {
  const out = [];
  let bytes = 0;
  while (out.length < n) {
    const chunk = await rs.getRows(Math.min(n - out.length, out.length === 0 ? 50 : 500));
    for (const r of chunk) { const row = r.map(cellValue); out.push(row); bytes += rowBytes(row); }
    if (chunk.length === 0) return { rows: out, end: true };
    if (bytes >= budget) return { rows: out, end: false };
  }
  return { rows: out, end: false };
}

class OracleSession {
  /**
   * cfg: {method: 'easy'|'tns'|'wallet', host, port, service, sid, connectString, tnsAlias, configDir, walletDir,
   *       user, privilege: ''|'SYSDBA'|..., readOnly, connectTimeoutMs, dbmsOutput}
   * secret: password. cfg.walletPassword (optional) comes from SecretStorage too.
   */
  constructor(cfg, secret) {
    this.cfg = cfg;
    this.secret = secret;
    this.dialect = 'oracle';
    this.main = null;
    this.meta = null;
    this.active = null;
    this.onDrop = null;
    this.serverOutput = cfg.dbmsOutput !== false;
  }

  connectString() {
    const c = this.cfg;
    if (c.method === 'tns' || c.method === 'wallet') return c.tnsAlias || c.connectString || '';
    if (c.connectString) return c.connectString;
    const host = /:/.test(c.host) && !/^\[/.test(c.host) ? `[${c.host}]` : c.host;
    if (c.sid) return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${c.host})(PORT=${Number(c.port) || 1521}))(CONNECT_DATA=(SID=${c.sid})))`;
    return `${host}:${Number(c.port) || 1521}/${c.service || ''}`;
  }

  connectOptions() {
    const c = this.cfg;
    const o = {
      user: c.user, password: this.secret || '', connectString: this.connectString(),
      connectTimeout: Math.max(1, Math.round((c.connectTimeoutMs || 10000) / 1000)),
      transportConnectTimeout: Math.max(1, Math.round((c.connectTimeoutMs || 10000) / 1000)),
      retryCount: 0,
      driverName: 'Zovo Oracle SQL Client : 0.1',
      machine: undefined,
    };
    const dir = c.configDir || process.env.TNS_ADMIN;
    if ((c.method === 'tns' || c.method === 'wallet') && dir) o.configDir = dir;
    if (c.method === 'wallet' && (c.walletDir || dir)) { o.walletLocation = c.walletDir || dir; if (c.walletPassword) o.walletPassword = c.walletPassword; }
    if (c.privilege && T[c.privilege]) o.privilege = T[c.privilege];
    return o;
  }

  checkConfig() {
    const c = this.cfg;
    if (c.method === 'tns' || c.method === 'wallet') {
      const dir = c.configDir || process.env.TNS_ADMIN;
      if (!dir) throw Object.assign(new Error('Pick the folder that holds tnsnames.ora (or set TNS_ADMIN).'), { friendly: true });
      const file = path.join(dir, 'tnsnames.ora');
      if (!fs.existsSync(file)) throw Object.assign(new Error(`There is no tnsnames.ora in ${dir}.`), { friendly: true });
      const problem = checkTnsnames(fs.readFileSync(file, 'utf8'), c.tnsAlias);
      if (problem) throw Object.assign(new Error(`${file}: ${problem}`), { friendly: true });
      if (c.method === 'wallet' && !fs.existsSync(path.join(c.walletDir || dir, 'ewallet.pem'))) {
        throw Object.assign(new Error(`There is no ewallet.pem in ${c.walletDir || dir}. Thin mode reads the PEM wallet from the Autonomous Database wallet zip.`), { friendly: true });
      }
    }
  }

  async connectClient(role) {
    this.checkConfig();
    let conn;
    try {
      conn = await oracledb.getConnection(this.connectOptions());
    } catch (e) {
      throw friendlyError(e, this.cfg, 'oracle');
    }
    conn._zovoRole = role;
    conn.autoCommit = false;
    try {
      await conn.execute(`ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM' NLS_NUMERIC_CHARACTERS = '.,'`);
      conn.module = 'Zovo SQL Client';
    } catch { /* defaults stay */ }
    if (this.cfg.readOnly) {
      // 23ai and later: the session refuses every write, DDL included (ORA-28193). Older: each transaction is read-only.
      try { await conn.execute('ALTER SESSION SET READ_ONLY = TRUE'); conn._zovoSessionRO = true; } catch { conn._zovoSessionRO = false; }
    }
    return conn;
  }

  async open() {
    if (!this.main) {
      this.main = await this.connectClient('main');
      const r = await this.main.execute(`SELECT SYS_CONTEXT('USERENV','DB_NAME') AS db, SYS_CONTEXT('USERENV','SESSION_USER') AS u, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS s FROM dual`, [], { outFormat: T.OUT_FORMAT_OBJECT });
      const row = r.rows[0] || {};
      this.info = { version: `Oracle Database ${this.main.oracleServerVersionString}`, database: row.DB, user: row.U, schema: row.S };
      if (this.serverOutput) await this.enableOutput(true).catch(() => {});
    }
    return this.info;
  }

  async enableOutput(on) {
    this.serverOutput = on;
    if (!this.main) return;
    await this.main.execute(on ? 'BEGIN DBMS_OUTPUT.ENABLE(NULL); END;' : 'BEGIN DBMS_OUTPUT.DISABLE; END;');
  }

  /** Lines that PL/SQL wrote with DBMS_OUTPUT.PUT_LINE since the last call. */
  async outputLines(conn) {
    const out = [];
    for (let k = 0; k < 200; k++) {
      const r = await conn.execute('BEGIN DBMS_OUTPUT.GET_LINES(:lines, :n); END;', {
        lines: { dir: T.BIND_OUT, type: T.STRING, maxSize: 32767, maxArraySize: 1000 },
        n: { dir: T.BIND_INOUT, type: T.NUMBER, val: 1000 },
      });
      const lines = (r.outBinds.lines || []).slice(0, Number(r.outBinds.n) || 0);
      for (const l of lines) out.push(l === null ? '' : l);
      if (r.outBinds.n < 1000) break;
    }
    return out;
  }

  async metaClient() {
    if (!this.meta) this.meta = await this.connectClient('meta');
    return this.meta;
  }

  async metaQuery(sql, binds = {}) {
    const run = async () => {
      const c = await this.metaClient();
      const r = await c.execute(sql, binds, { outFormat: T.OUT_FORMAT_OBJECT, fetchTypeHandler, maxRows: 100000 });
      return r.rows || [];
    };
    try {
      return await run();
    } catch (e) {
      if (isConnectionLost(e)) { this.meta = null; try { return await run(); } catch (e2) { throw friendlyError(e2, this.cfg, 'oracle', sql); } }
      throw friendlyError(e, this.cfg, 'oracle', sql);
    }
  }

  async closeActive() {
    const a = this.active;
    this.active = null;
    if (a) await a.close();
  }

  /**
   * Run one statement or PL/SQL block. hooks.client marks a SQL*Plus line (SET SERVEROUTPUT ON ...).
   * @returns {{sets, notices, rowCounts, command}}
   */
  async runBatch(sql, maxRows, hooks = {}) {
    await this.closeActive();
    if (hooks.client) return this.clientCommand(sql);
    let retried = false;
    for (;;) {
      let sent = false;
      try {
        await this.open();
        sent = true;
        return await this.execOne(sql, maxRows, hooks);
      } catch (e) {
        if (!retried && isConnectionLost(e) && (!sent || /^\s*(SELECT|WITH)\b/i.test(sql))) {
          retried = true;
          await this.dropMain();
          if (hooks.onNotice) hooks.onNotice('The connection was lost. Reconnected and ran the statement again.');
          continue;
        }
        if (isConnectionLost(e)) await this.dropMain();
        throw e instanceof Error && e.friendly ? e : friendlyError(e, this.cfg, 'oracle', sql);
      }
    }
  }

  async dropMain() {
    const m = this.main;
    this.main = null;
    this.active = null;
    if (m) { try { await m.close(); } catch { /* gone */ } }
  }

  async clientCommand(text) {
    const t = text.trim();
    const notices = [];
    const m = /^SET\s+SERVEROUT(?:PUT)?\s+(ON|OFF)\b/i.exec(t);
    if (m) {
      await this.open();
      await this.enableOutput(m[1].toUpperCase() === 'ON');
      notices.push(`DBMS_OUTPUT is ${m[1].toUpperCase() === 'ON' ? 'on' : 'off'} for this session.`);
    } else if (/^PROMPT\b/i.test(t)) notices.push(t.replace(/^PROMPT\s?/i, ''));
    else notices.push(`Skipped the SQL*Plus command "${t.slice(0, 60)}": it only changes SQL*Plus output.`);
    return { sets: [], notices, rowCounts: [], command: 'SQL*Plus' };
  }

  async execOne(sql, maxRows, hooks) {
    const conn = this.main;
    if (this.cfg.readOnly && !conn._zovoSessionRO) {
      await conn.execute('ROLLBACK');
      await conn.execute('SET TRANSACTION READ ONLY');
    }
    const plsql = /^\s*(DECLARE|BEGIN|<<)/i.test(sql);
    const text = plsql || /^\s*CREATE\s+(OR\s+REPLACE\s+)?((NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY|JAVA)\b/i.test(sql) ? sql : sql.replace(/;\s*$/, '');
    let r;
    try {
      r = await conn.execute(text, [], { resultSet: true, outFormat: T.OUT_FORMAT_ARRAY, fetchTypeHandler, autoCommit: !this.cfg.readOnly && this.cfg.autoCommit !== false });
    } catch (e) {
      const notices = this.serverOutput ? await this.outputLines(conn).catch(() => []) : [];
      const f = friendlyError(e, this.cfg, 'oracle', sql);
      if (notices.length) f.notices = notices;
      throw f;
    }
    const batch = { sets: [], notices: [], rowCounts: [], command: (/^\s*([A-Za-z]+)/.exec(sql) || [])[1] || 'Statement' };
    const rsList = [];
    if (r.resultSet) rsList.push({ rs: r.resultSet, meta: r.metaData });
    for (const ir of r.implicitResults || []) rsList.push({ rs: ir, meta: ir.metaData });
    if (r.rowsAffected !== undefined && !r.resultSet) batch.rowCounts.push(r.rowsAffected);
    if (r.warning) batch.notices.push(await this.compileErrors(sql, r.warning));
    for (const x of rsList) {
      const columns = (x.meta || []).map(describe);
      const first = await readRows(x.rs, maxRows);
      const set = {
        columns, rows: first.rows, done: first.end,
        fetchMore: async (n) => {
          if (set.done) return [];
          try {
            const more = await readRows(x.rs, n);
            if (more.end) { set.done = true; await closeRs(); }
            return more.rows;
          } catch (e) {
            set.done = true;
            throw friendlyError(e, this.cfg, 'oracle', sql);
          }
        },
        close: async () => { set.done = true; await closeRs(); },
      };
      let closed = false;
      const closeRs = async () => { if (closed) return; closed = true; try { await x.rs.close(); } catch { /* gone */ } };
      if (set.done) await closeRs();
      batch.sets.push(set);
    }
    const open = batch.sets.filter((s) => !s.done);
    if (open.length) this.active = { close: async () => { for (const s of open) await s.close(); } };
    if (this.serverOutput) batch.notices.push(...await this.outputLines(conn).catch(() => []));
    return batch;
  }

  /** "Created with compilation errors": read USER_ERRORS so the message says where. */
  async compileErrors(sql, warning) {
    const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PACKAGE\s+BODY|TYPE\s+BODY|PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE)\s+(?:"?([\w$#]+)"?\s*\.\s*)?"?([\w$#]+)"?/i.exec(sql);
    if (!m) return String(warning.message || warning);
    const type = m[1].toUpperCase().replace(/\s+/g, ' ');
    const name = m[3].toUpperCase();
    try {
      const rows = await this.metaQuery(`SELECT line, position, text FROM all_errors WHERE owner = NVL(:o, SYS_CONTEXT('USERENV','CURRENT_SCHEMA')) AND name = :n AND type = :t ORDER BY sequence`, { o: m[2] ? m[2].toUpperCase() : null, n: name, t: type });
      if (!rows.length) return `${type} ${name} was created with compilation errors.`;
      const e = rows[0];
      const err = Object.assign(new Error(`${type} ${name} was created with compilation errors. Line ${e.LINE}, column ${e.POSITION}: ${String(e.TEXT).trim()}${rows.length > 1 ? ` (and ${rows.length - 1} more)` : ''}`), { friendly: true, line: Number(e.LINE) - 1, column: Number(e.POSITION) - 1, warning: true });
      throw err;
    } catch (e) {
      if (e.warning) throw e;
      return `${type} ${name} was created with compilation errors.`;
    }
  }

  /** Stop the running statement (sends a break to the server). */
  async cancel() {
    if (!this.main) return false;
    await this.main.break();
    return true;
  }

  /** Table and key for a result opened from the explorer (SELECT * of one table), or a reason why not. */
  async editTarget(columns, sql, table) {
    if (!columns.length) return { reason: 'This result has no columns.' };
    if (!table || !table.table) return { reason: 'Open a table from the explorer to edit its rows. Query results are read-only.' };
    const owner = table.schema;
    const t = await this.metaQuery(`SELECT object_type FROM all_objects WHERE owner = :o AND object_name = :t AND object_type IN ('TABLE','VIEW')`, { o: owner, t: table.table });
    if (!t.length) return { reason: 'The source table was not found.' };
    if (t[0].OBJECT_TYPE === 'VIEW') return { reason: `${table.table} is a view, so its rows are read-only here.` };
    const pkRows = await this.metaQuery(`SELECT cc.column_name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
      WHERE c.owner = :o AND c.table_name = :t AND c.constraint_type = 'P' ORDER BY cc.position`, { o: owner, t: table.table });
    const pk = pkRows.map((r) => r.COLUMN_NAME);
    if (!pk.length) return { reason: `${table.table} has no primary key, so the grid cannot tell rows apart. It stays read-only.`, schema: owner, table: table.table };
    const cols = await this.metaQuery(`SELECT column_name, virtual_column, identity_column FROM all_tab_cols WHERE owner = :o AND table_name = :t AND hidden_column = 'NO' ORDER BY column_id`, { o: owner, t: table.table });
    const byName = new Map(cols.map((c) => [c.COLUMN_NAME, c]));
    const colNames = columns.map((c) => (byName.has(c.name) ? c.name : null));
    const editable = columns.map((c, i) => {
      const x = byName.get(colNames[i]);
      return !!x && !c.binary && x.VIRTUAL_COLUMN !== 'YES' && x.IDENTITY_COLUMN !== 'YES';
    });
    return { schema: owner, table: table.table, pk, columns: colNames, editable, allColumns: cols.map((c) => ({ name: c.COLUMN_NAME })) };
  }

  /** Run the statements in one transaction on the meta connection. Each must change exactly `expect` rows. */
  async transaction(statements) {
    const c = await this.metaClient();
    const done = [];
    try {
      for (const st of statements) {
        const r = await c.execute(st.sql, [], { autoCommit: false });
        if (st.expect !== undefined && r.rowsAffected !== st.expect) throw Object.assign(new Error(`"${st.sql.slice(0, 120)}" changed ${r.rowsAffected} rows instead of ${st.expect}. Nothing was saved.`), { friendly: true });
        done.push(r.rowsAffected);
      }
      await c.commit();
      return done;
    } catch (e) {
      try { await c.rollback(); } catch { /* gone */ }
      throw friendlyError(e, this.cfg, 'oracle');
    }
  }

  /** Stream a query to onBatch(columns, rows), on its own connection so the editor stays free. */
  async exportQuery(sql, onBatch, shouldStop, batchSize = 5000) {
    const conn = await this.connectClient('export');
    try {
      const r = await conn.execute(sql.replace(/;\s*$/, ''), [], { resultSet: true, outFormat: T.OUT_FORMAT_ARRAY, fetchTypeHandler, prefetchRows: 1000, fetchArraySize: 1000 });
      if (!r.resultSet) return { rows: 0, columns: [] };
      const columns = (r.metaData || []).map(describe);
      const lobs = columns.some((c) => c.lob);
      let total = 0;
      for (;;) {
        const { rows, end } = await readRows(r.resultSet, lobs ? 200 : batchSize, 32 * 1024 * 1024);
        if (rows.length) { await onBatch(columns, rows); total += rows.length; }
        if (end || (shouldStop && shouldStop())) break;
      }
      await r.resultSet.close().catch(() => {});
      return { rows: total, columns };
    } catch (e) {
      throw friendlyError(e, this.cfg, 'oracle', sql);
    } finally {
      try { await conn.close(); } catch { /* closed */ }
    }
  }

  // ---------- schema for the explorer, autocomplete, ER diagram and schema compare ----------

  /** Oracle has schemas (users), not databases: one level less in the explorer. */
  async databases() { return []; }

  async schemas() {
    const r = await this.metaQuery(`SELECT u.username AS name, (SELECT COUNT(*) FROM all_objects o WHERE o.owner = u.username AND o.object_type IN ('TABLE','VIEW')) AS n
      FROM all_users u WHERE u.oracle_maintained = 'N' OR u.username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA')
      ORDER BY CASE WHEN u.username = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') THEN 0 ELSE 1 END, u.username`)
      .catch(() => this.metaQuery(`SELECT username AS name, NULL AS n FROM all_users ORDER BY CASE WHEN username = USER THEN 0 ELSE 1 END, username`));
    return r.map((x) => ({ name: x.NAME, count: x.N === null ? null : Number(x.N) }));
  }

  async tables(schema) {
    const r = await this.metaQuery(`SELECT o.object_name AS name, o.object_type AS type, t.num_rows AS est FROM all_objects o
      LEFT JOIN all_tables t ON t.owner = o.owner AND t.table_name = o.object_name
      WHERE o.owner = :o AND o.object_type IN ('TABLE','VIEW') AND o.object_name NOT LIKE 'BIN$%' AND o.object_name NOT LIKE 'DR$%' ORDER BY o.object_name`, { o: schema });
    return r.map((x) => ({ name: x.NAME, kind: x.TYPE === 'VIEW' ? 'view' : 'table', rows: x.EST === null || x.EST === undefined ? null : Number(x.EST) }));
  }

  async routines(schema) {
    const r = await this.metaQuery(`SELECT object_name AS name, object_type AS type, status FROM all_objects
      WHERE owner = :o AND object_type IN ('PROCEDURE','FUNCTION','PACKAGE') ORDER BY object_type, object_name`, { o: schema });
    return r.map((x) => ({ name: x.NAME, kind: String(x.TYPE).toLowerCase(), invalid: x.STATUS === 'INVALID' }));
  }

  async columns(schema, table) {
    const r = await this.metaQuery(`SELECT c.column_name AS name, c.data_type AS type, c.data_length AS len, c.char_length AS clen, c.char_used AS cu, c.data_precision AS prec, c.data_scale AS scale,
        c.nullable AS nullable, c.data_default AS dflt,
        CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
          WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'P' AND kc.column_name = c.column_name) THEN 1 ELSE 0 END AS pk
      FROM all_tab_columns c WHERE c.owner = :o AND c.table_name = :t ORDER BY c.column_id`, { o: schema, t: table });
    return r.map((x) => ({ name: x.NAME, type: oraType(x), notNull: x.NULLABLE === 'N', default: x.DFLT == null ? null : String(x.DFLT).trim(), pk: Number(x.PK) === 1 }));
  }

  async indexes(schema, table) {
    const r = await this.metaQuery(`SELECT i.index_name AS name, i.uniqueness AS u, i.index_type AS kind,
        (SELECT LISTAGG(ic.column_name || CASE WHEN ic.descend = 'DESC' THEN ' DESC' END, ', ') WITHIN GROUP (ORDER BY ic.column_position) FROM all_ind_columns ic WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name) AS cols,
        (SELECT COUNT(*) FROM all_constraints k WHERE k.owner = i.table_owner AND k.index_name = i.index_name AND k.constraint_type = 'P') AS pk
      FROM all_indexes i WHERE i.table_owner = :o AND i.table_name = :t ORDER BY i.index_name`, { o: schema, t: table });
    return r.map((x) => ({ name: x.NAME, def: `${String(x.KIND).toLowerCase()} (${x.COLS || ''})`, pk: Number(x.PK) > 0, unique: x.U === 'UNIQUE' }));
  }

  async schemaColumns(schema, limit = 20000) {
    const r = await this.metaQuery(`SELECT * FROM (SELECT c.table_name AS t, o.object_type AS k, c.column_name AS name, c.data_type AS type, c.data_length AS len, c.char_length AS clen, c.char_used AS cu,
        c.data_precision AS prec, c.data_scale AS scale, c.nullable AS nullable,
        CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
          WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'P' AND kc.column_name = c.column_name) THEN 1 ELSE 0 END AS pk
      FROM all_tab_columns c JOIN all_objects o ON o.owner = c.owner AND o.object_name = c.table_name AND o.object_type IN ('TABLE','VIEW')
      WHERE c.owner = :o AND c.table_name NOT LIKE 'BIN$%' ORDER BY c.table_name, c.column_id) WHERE ROWNUM <= :lim`, { o: schema, lim: limit });
    const map = new Map();
    for (const x of r) {
      if (!map.has(x.T)) map.set(x.T, { name: x.T, kind: x.K === 'VIEW' ? 'view' : 'table', columns: [] });
      map.get(x.T).columns.push({ name: x.NAME, type: oraType(x), notNull: x.NULLABLE === 'N', default: null, pk: Number(x.PK) === 1 });
    }
    return [...map.values()];
  }

  async foreignKeys(schema) {
    const r = await this.metaQuery(`SELECT c.constraint_name AS name, c.table_name AS t, r.owner AS fschema, r.table_name AS ft,
        (SELECT LISTAGG(cc.column_name, ',') WITHIN GROUP (ORDER BY cc.position) FROM all_cons_columns cc WHERE cc.owner = c.owner AND cc.constraint_name = c.constraint_name) AS cols,
        (SELECT LISTAGG(rc.column_name, ',') WITHIN GROUP (ORDER BY rc.position) FROM all_cons_columns rc WHERE rc.owner = r.owner AND rc.constraint_name = r.constraint_name) AS fcols
      FROM all_constraints c JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
      WHERE c.owner = :o AND c.constraint_type = 'R' ORDER BY c.table_name, c.constraint_name`, { o: schema });
    return r.map((x) => ({ name: x.NAME, table: x.T, columns: String(x.COLS || '').split(','), refSchema: x.FSCHEMA, refTable: x.FT, refColumns: String(x.FCOLS || '').split(',') }));
  }

  /** CREATE text from DBMS_METADATA (Pro: schema DDL export; free: "Script as CREATE"). */
  async ddl(schema, name, kind) {
    const type = { table: 'TABLE', view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', package: 'PACKAGE' }[kind] || 'TABLE';
    const c = await this.metaClient();
    try {
      await c.execute(`BEGIN DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE); DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE); END;`).catch(() => {});
      const r = await c.execute(`SELECT DBMS_METADATA.GET_DDL(:t, :n, :o) AS ddl FROM dual`, { t: type, n: name, o: schema }, { outFormat: T.OUT_FORMAT_OBJECT, fetchTypeHandler });
      let text = String((r.rows[0] || {}).DDL || '').trim();
      if (type === 'PACKAGE') text += '\n/\n';
      else if (type !== 'TABLE' && type !== 'VIEW') text += '\n/\n';
      return text + '\n';
    } catch (e) {
      throw friendlyError(e, this.cfg, 'oracle');
    }
  }

  /** EXPLAIN PLAN as rows of a tree (Pro). The query itself does not run. */
  async explain(sql) {
    const c = await this.metaClient();
    const id = `ZOVO${Date.now().toString(36).toUpperCase()}`;
    try {
      await c.execute(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${sql.replace(/;\s*$/, '')}`);
      const r = await c.execute(`SELECT id, parent_id, depth, operation, options, object_owner, object_name, cost, cardinality, bytes, access_predicates, filter_predicates
        FROM plan_table WHERE statement_id = :id ORDER BY id`, { id }, { outFormat: T.OUT_FORMAT_OBJECT });
      await c.execute(`DELETE FROM plan_table WHERE statement_id = :id`, { id }).catch(() => {});
      await c.commit().catch(() => {});
      return { format: 'oracle', rows: r.rows };
    } catch (e) {
      throw friendlyError(e, this.cfg, 'oracle', sql);
    }
  }

  async close() {
    const all = [this.main, this.meta].filter(Boolean);
    this.main = null; this.meta = null; this.active = null;
    await Promise.all(all.map((c) => c.close().catch(() => {})));
  }
}

function oraType(x) {
  const t = String(x.TYPE || '');
  if (/^(N?VARCHAR2|N?CHAR)$/.test(t)) return `${t.toLowerCase()}(${x.CLEN || x.LEN}${x.CU === 'C' && !/^N/.test(t) ? ' char' : ''})`;
  if (t === 'NUMBER' && x.PREC != null) return x.SCALE ? `number(${x.PREC},${x.SCALE})` : `number(${x.PREC})`;
  if (t === 'RAW') return `raw(${x.LEN})`;
  return t.toLowerCase();
}

/**
 * A quick syntax check of tnsnames.ora: balanced parentheses per entry and the alias present.
 * Returns a sentence about the first problem, or ''.
 */
function checkTnsnames(text, alias) {
  const src = String(text).replace(/#[^\n]*/g, '');
  let depth = 0;
  let line = 1;
  const names = [];
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') line++;
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth < 0) return `a ")" on line ${line} has no matching "(".`; }
    else if (depth === 0) {
      if (ch === '=') { const n = cur.trim(); if (n) names.push(...n.split(',').map((x) => x.trim().toUpperCase())); cur = ''; } else cur += ch;
    }
  }
  if (depth > 0) return `an entry is missing ${depth} closing ")" (the file ends inside an entry).`;
  if (alias) {
    const want = String(alias).toUpperCase();
    if (!names.some((n) => n === want || n.split('.')[0] === want)) return `the alias "${alias}" is not in this file. Aliases found: ${names.slice(0, 12).join(', ') || 'none'}.`;
  }
  return '';
}

/** Aliases in a tnsnames.ora text, for the connection form's pick list. */
function tnsAliases(text) {
  const src = String(text).replace(/#[^\n]*/g, '');
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of src) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) { if (ch === '=') { const n = cur.trim(); if (n) out.push(...n.split(',').map((x) => x.trim())); cur = ''; } else cur += ch; }
  }
  return out.filter((x) => /^[\w.$#-]+$/.test(x));
}

module.exports = { OracleSession, checkTnsnames, tnsAliases, describe, oraType, cellValue, intervalText };

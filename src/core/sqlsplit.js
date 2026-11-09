'use strict';
// Splits SQL text into the units the server runs, without a parser.
// dialect 'mssql' (T-SQL): a line that holds only GO (optionally "GO 3") ends a batch. A batch runs as one request,
// so DECLARE'd variables, temp tables and PRINT behave as in other SQL Server tools.
// dialect 'oracle': ';' ends a SQL statement (the ';' is not sent). PL/SQL blocks (DECLARE, BEGIN, CREATE PROCEDURE,
// FUNCTION, PACKAGE, TRIGGER, TYPE) end at a line that holds only '/'. A few SQL*Plus lines (SET SERVEROUTPUT,
// PROMPT, SET DEFINE ...) are recognised as client commands so scripts copied from other tools still run.
// Quotes, [identifiers], comments and Oracle q'[...]' strings never split anything.

const PLSQL_START = /^\s*(DECLARE\b|BEGIN\b|<<|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE|LIBRARY|JAVA)\b|WITH\s+FUNCTION\b|WITH\s+PROCEDURE\b)/i;
const SQLPLUS = /^(SET|PROMPT|SPOOL|WHENEVER|EXIT|QUIT|COLUMN|COL|TTITLE|BTITLE|BREAK|COMPUTE|DEFINE|UNDEFINE|PAUSE|ACCEPT|REM|REMARK|SHOW|CLEAR|VARIABLE|VAR|PRINT|CONNECT|CONN|DISCONNECT|@@?)(\s|$)/i;
// SET <word> is a SQL*Plus command only for these settings; everything else (SET TRANSACTION, SET ROLE) is SQL.
const SQLPLUS_SET = /^SET\s+(SERVEROUTPUT|SERVEROUT|DEFINE|ECHO|FEEDBACK|FEED|HEADING|HEAD|LINESIZE|LINES|PAGESIZE|PAGES|TIMING|TERMOUT|TERM|VERIFY|VER|TRIMSPOOL|TRIMOUT|SQLBLANKLINES|LONG|NULL|COLSEP|AUTOCOMMIT|AUTOTRACE|TAB|WRAP|SCAN|ESCAPE|CONCAT|NUMWIDTH|SQLPROMPT|APPINFO|MARKUP)\b/i;

function lineEnd(s, i) {
  const e = s.indexOf('\n', i);
  return e < 0 ? s.length : e + 1;
}

/** End offset (exclusive) of a quoted string or identifier that starts at i. */
function quoteEnd(s, i, q) {
  let j = i + 1;
  const close = q === '[' ? ']' : q;
  while (j < s.length) {
    if (s[j] === close) {
      if (s[j + 1] === close) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return s.length;
}

/** Oracle q'Xtext X' strings (also nq'...'). Returns the end offset, or -1 when s[i] does not start one. */
function qQuoteEnd(s, i) {
  if (!/[qQ]/.test(s[i]) || s[i + 1] !== "'") return -1;
  if (i > 0 && /[A-Za-z0-9_$#]/.test(s[i - 1]) && !/[nN]/.test(s[i - 1])) return -1;
  const open = s[i + 2];
  if (!open || /\s/.test(open)) return -1;
  const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] || open;
  const e = s.indexOf(close + "'", i + 3);
  return e < 0 ? s.length : e + 2;
}

/** Skip a comment, string or quoted name at i. Returns the new offset, or -1 when nothing starts at i. */
function skipToken(s, i, dialect) {
  const c = s[i];
  const next = s[i + 1];
  if (c === '-' && next === '-') return lineEnd(s, i);
  if (c === '/' && next === '*') {
    const e = s.indexOf('*/', i + 2);
    return e < 0 ? s.length : e + 2;
  }
  if (dialect === 'oracle') {
    const q = qQuoteEnd(s, i);
    if (q >= 0) return q;
  }
  if (c === "'" || c === '"') return quoteEnd(s, i, c);
  if (c === '[' && dialect === 'mssql') return quoteEnd(s, i, '[');
  return -1;
}

/** The trimmed statement between a and b, with its offsets. Null when it is empty or only comments. */
function piece(s, a, b, dialect, extra) {
  const raw = s.slice(a, b);
  const lead = raw.length - raw.replace(/^\s+/, '').length;
  const text = raw.trim();
  if (!text || stripComments(text, dialect).trim() === '') return null;
  return { start: a + lead, end: a + lead + text.length, text, ...(extra || {}) };
}

/**
 * @returns {{start:number,end:number,text:string,repeat?:number,client?:boolean,plsql?:boolean}[]}
 * start..end are offsets in the input of the text that is sent (for the error marker).
 */
function splitStatements(sql, dialect) {
  return dialect === 'oracle' ? splitOracle(String(sql || '')) : splitMssql(String(sql || ''));
}

function isLineStart(s, i) {
  let j = i - 1;
  while (j >= 0 && (s[j] === ' ' || s[j] === '\t')) j--;
  return j < 0 || s[j] === '\n';
}

// ---------- T-SQL ----------

function splitMssql(s) {
  const out = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const skip = skipToken(s, i, 'mssql');
    if (skip >= 0) { i = skip; continue; }
    if ((s[i] === 'G' || s[i] === 'g') && isLineStart(s, i)) {
      const m = /^go(?:[ \t]+(\d+))?[ \t]*(?:--[^\n]*)?(?:\r?\n|$)/i.exec(s.slice(i, i + 40));
      if (m) {
        const p = piece(s, start, i, 'mssql', { repeat: m[1] ? Math.max(1, Math.min(1000, Number(m[1]))) : 1 });
        if (p) out.push(p);
        i += m[0].length;
        start = i;
        continue;
      }
    }
    i++;
  }
  const p = piece(s, start, s.length, 'mssql', { repeat: 1 });
  if (p) out.push(p);
  return out;
}

/** Statements inside one T-SQL batch, split at top-level semicolons (for "run the statement at the cursor"). */
function splitSemicolons(s, dialect) {
  const out = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const skip = skipToken(s, i, dialect);
    if (skip >= 0) { i = skip; continue; }
    if (s[i] === ';') {
      const p = piece(s, start, i, dialect);
      if (p) out.push(p);
      start = i + 1;
    }
    i++;
  }
  const p = piece(s, start, s.length, dialect);
  if (p) out.push(p);
  return out;
}

// A batch with one of these runs whole: its semicolons are inside a block, or it needs its variables.
const MSSQL_BLOCK = /\b(BEGIN|DECLARE|CREATE\s+(?:OR\s+ALTER\s+)?(?:PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)|ALTER\s+(?:PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)|IF|WHILE|GOTO|TRY|CATCH)\b|@/i;

// ---------- Oracle ----------

function splitOracle(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Skip blank space and comments between statements.
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if ((s[i] === '-' && s[i + 1] === '-') || (s[i] === '/' && s[i + 1] === '*')) { i = skipToken(s, i, 'oracle'); continue; }
    const start = i;
    const lineText = s.slice(i, lineEnd(s, i)).replace(/\r?\n$/, '');
    // A lone '/' runs the previous block again in SQL*Plus. Here it only ends blocks: skip a stray one.
    if (/^\/\s*$/.test(lineText)) { i = lineEnd(s, i); continue; }
    const first = lineText.trim();
    // REM / REMARK lines are SQL*Plus comments: skip them like -- comments (Oracle's own scripts open with dozens).
    if (/^REM(ARK)?(\s|$)/i.test(first)) { i = lineEnd(s, i); continue; }
    if (SQLPLUS.test(first) && (!/^SET\s/i.test(first) || SQLPLUS_SET.test(first)) && !/^PRINT\s*\(/i.test(first)) {
      const p = piece(s, start, i + lineText.length, 'oracle', { client: true });
      if (p) { p.text = p.text.replace(/;\s*$/, ''); out.push(p); }
      i = lineEnd(s, i);
      continue;
    }
    const head = stripComments(s.slice(i, i + 400), 'oracle');
    if (PLSQL_START.test(head)) {
      // A PL/SQL block runs to a line that holds only '/', or to the end of the text.
      let j = i;
      let end = n;
      let after = n;
      while (j < n) {
        const skip = skipToken(s, j, 'oracle');
        if (skip >= 0) { j = skip; continue; }
        if (s[j] === '/' && isLineStart(s, j)) {
          const m = /^\/[ \t]*(?:\r?\n|$)/.exec(s.slice(j, j + 40));
          if (m) { end = j; after = j + m[0].length; break; }
        }
        j++;
      }
      const p = piece(s, start, end, 'oracle', { plsql: true });
      if (p) out.push(p);
      i = after;
      continue;
    }
    // Plain SQL: to the next top-level ';' or a '/' line.
    let j = i;
    let end = n;
    let after = n;
    while (j < n) {
      const skip = skipToken(s, j, 'oracle');
      if (skip >= 0) { j = skip; continue; }
      if (s[j] === ';') { end = j; after = j + 1; break; }
      if (s[j] === '/' && isLineStart(s, j) && /^\/[ \t]*(?:\r?\n|$)/.test(s.slice(j, j + 40))) { end = j; after = lineEnd(s, j); break; }
      j++;
    }
    const p = piece(s, start, end, 'oracle');
    if (p) out.push(p);
    i = after;
  }
  return out;
}

/** The text with comments removed (strings kept). */
function stripComments(sql, dialect) {
  const s = String(sql || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '-' && next === '-') { i = lineEnd(s, i); out += '\n'; continue; }
    if (c === '/' && next === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out += ' '; continue; }
    const e = skipToken(s, i, dialect);
    if (e >= 0) { out += s.slice(i, e); i = e; continue; }
    out += c; i++;
  }
  return out;
}

/** Text with strings, quoted names and comments blanked, for keyword checks. */
function skeleton(sql, dialect) {
  const s = String(sql || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '-' && next === '-') { const e = lineEnd(s, i); out += ' '.repeat(e - i - 1) + (s[e - 1] === '\n' ? '\n' : ' '); i = e; continue; }
    if (c === '/' && next === '*') { const e0 = s.indexOf('*/', i + 2); const e = e0 < 0 ? s.length : e0 + 2; out += s.slice(i, e).replace(/[^\n]/g, ' '); i = e; continue; }
    const e = skipToken(s, i, dialect);
    if (e >= 0) { out += s.slice(i, e).replace(/[^\n]/g, ' '); i = e; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * The unit to run for "run at cursor": Oracle: the statement or block at the offset.
 * T-SQL: the statement at the offset when its GO batch has no block or variables, else the whole batch.
 */
function statementAt(sql, offset, dialect) {
  const list = splitStatements(sql, dialect);
  if (!list.length) return null;
  let hit = null;
  for (const st of list) if (offset >= st.start && offset <= st.end + 1) { hit = st; break; }
  if (!hit) {
    for (const st of list) if (st.end <= offset) hit = st;
    hit = hit || list[0];
  }
  if (dialect !== 'mssql') return hit;
  const sk = skeleton(hit.text, 'mssql');
  if (MSSQL_BLOCK.test(sk)) return hit;
  const parts = splitSemicolons(hit.text, 'mssql');
  if (parts.length <= 1) return hit;
  const rel = offset - hit.start;
  let best = parts[0];
  for (const p of parts) {
    if (rel >= p.start && rel <= p.end + 1) { best = p; break; }
    if (p.end <= rel) best = p;
  }
  return { start: hit.start + best.start, end: hit.start + best.end, text: best.text, repeat: 1 };
}

function firstKeyword(sql, dialect) {
  const m = /^[\s(]*([A-Za-z]+)/.exec(skeleton(sql, dialect));
  return m ? m[1].toUpperCase() : '';
}

const STMT_START = /^(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|EXEC|EXECUTE|DECLARE|SET|IF|BEGIN|END|PRINT|WITH|RETURN|COMMIT|ROLLBACK|GRANT|REVOKE|USE|RAISERROR|THROW|WHILE|CALL)\b/i;
const BODY_DDL = /^\s*(CREATE|ALTER)\s+(OR\s+(REPLACE|ALTER)\s+)?((NON)?EDITIONABLE\s+)?(PROC|PROCEDURE|FUNCTION|TRIGGER|PACKAGE|TYPE|VIEW)\b/i;

/**
 * Statements in the text that change every row (UPDATE or DELETE without WHERE) or drop data (TRUNCATE, DROP).
 * Returns short descriptions, empty when there are none. Bodies of CREATE PROCEDURE and friends are not checked:
 * creating a procedure changes no rows.
 */
function riskyStatements(sql, dialect) {
  const sk = skeleton(sql, dialect);
  if (BODY_DDL.test(sk)) return [];
  const out = [];
  // Cut the skeleton into rough statements: at ';' and at lines that start with a statement keyword.
  const lines = sk.split('\n');
  const stmts = [];
  let cur = '';
  for (const line of lines) {
    const t = line.trim();
    if (STMT_START.test(t) && cur.trim() && !/^(SET)\b/i.test(t)) { stmts.push(cur); cur = ''; }
    for (const part of line.split(';').entries()) {
      const [k, text] = part;
      if (k > 0) { stmts.push(cur); cur = ''; }
      cur += text;
    }
    cur += '\n';
  }
  stmts.push(cur);
  for (const st of stmts) {
    const t = st.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const k = (/^\(*\s*([A-Za-z]+)/.exec(t) || [])[1];
    const K = k ? k.toUpperCase() : '';
    if (K === 'UPDATE' && /^\(*\s*UPDATE\s+STATISTICS\b/i.test(t)) continue; // T-SQL maintenance, changes no rows
    if (K === 'UPDATE' || K === 'DELETE') {
      if (!/\bWHERE\b/i.test(t) && !/\bWHERE\s+CURRENT\s+OF\b/i.test(t)) out.push(`${K} without WHERE`);
    } else if (K === 'WITH') {
      const m = /\)\s*(UPDATE|DELETE)\b([\s\S]*)$/i.exec(t);
      if (m && !/\bWHERE\b/i.test(m[2])) out.push(`${m[1].toUpperCase()} without WHERE`);
    } else if (K === 'TRUNCATE') out.push('TRUNCATE');
    else if (K === 'DROP') {
      const what = (/^DROP\s+([A-Za-z]+)/i.exec(t) || [])[1];
      out.push(`DROP ${what ? what.toUpperCase() : ''}`.trim());
    }
  }
  return out;
}

/** Back-compat helper used by older code paths and tests. */
function isUnboundedWrite(sql, dialect) {
  return riskyStatements(sql, dialect).length > 0;
}

const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|DENY|RENAME|COMMENT|BULK|UPSERT|REPLACE|COMMIT|SAVE|DBCC|BACKUP|RESTORE|KILL|SHUTDOWN|RECONFIGURE|PURGE|FLASHBACK|LOCK|ANALYZE|AUDIT|NOAUDIT)\b/i;

/**
 * A write the read-only switch refuses before it reaches the server (a clear message beats a server error).
 * The server-side guard catches the rest (see the drivers). Returns the word found, or ''.
 */
function writeKeyword(sql, dialect) {
  const sk = skeleton(sql, dialect).toUpperCase();
  // "FOR UPDATE", "ON DELETE CASCADE", "INSTEAD OF INSERT" are not writes on their own.
  const cleaned = sk.replace(/\bFOR\s+UPDATE\b/g, ' ').replace(/\bON\s+(DELETE|UPDATE)\b/g, ' ').replace(/\b(INSTEAD\s+OF|AFTER|BEFORE)\s+(INSERT|UPDATE|DELETE)\b/g, ' ')
    .replace(/\bCREATE\s+GLOBAL\s+TEMPORARY\b/g, 'CREATE').replace(/\bREPLACE\s*\(/g, ' (');
  const m = WRITE_WORDS.exec(cleaned);
  if (m) return m[1];
  if (/\bSELECT\b[\s\S]*\bINTO\s+[#\w[]/.test(cleaned) && dialect === 'mssql') return 'SELECT INTO';
  return '';
}

/** A query whose result can be wrapped in SELECT * FROM (...) for server-side sort and filter. */
function isWrappable(sql, dialect) {
  const k = firstKeyword(sql, dialect);
  if (!(k === 'SELECT' || k === 'WITH')) return false;
  const sk = skeleton(sql, dialect).toUpperCase();
  if (dialect === 'mssql' && splitSemicolons(sql, dialect).length > 1) return false;
  if (/\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(sk)) return false;
  if (/\bFOR\s+(UPDATE|XML|JSON|BROWSE)\b/.test(sk)) return false;
  if (/\bINTO\b/.test(sk)) return false;
  if (dialect === 'mssql' && /\bORDER\s+BY\b/.test(sk) && !/\b(TOP|OFFSET)\b/.test(sk)) return false; // T-SQL refuses ORDER BY in a derived table
  if (/\bCOMPUTE\b|\bOPTION\s*\(/.test(sk)) return false;
  return true;
}

module.exports = { splitStatements, splitSemicolons, statementAt, stripComments, skeleton, firstKeyword, riskyStatements, isUnboundedWrite, writeKeyword, isWrappable, PLSQL_START };

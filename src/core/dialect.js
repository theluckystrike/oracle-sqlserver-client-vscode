'use strict';
// SQL text the extension writes itself: quoted names and values, row edits, sort and filter wrappers,
// INSERT export lines, "SELECT TOP 100" lines. Every statement the grid commits is built here and shown first.
// dialect: 'mssql' (SQL Server, Azure SQL) | 'oracle'

const { isBinary, toText } = require('./values');

function quoteIdent(name, dialect) {
  const s = String(name);
  if (dialect === 'mssql') return '[' + s.replace(/]/g, ']]') + ']';
  return '"' + s.replace(/"/g, '""') + '"';
}

/** schema.table (schema left out when empty). */
function qualified(schema, table, dialect) {
  return (schema ? quoteIdent(schema, dialect) + '.' : '') + quoteIdent(table, dialect);
}

function quoteLiteral(v, dialect) {
  if (v === null || v === undefined) return 'NULL';
  if (isBinary(v)) {
    const hex = Buffer.from(v).toString('hex').toUpperCase();
    return dialect === 'mssql' ? `0x${hex}` : `HEXTORAW('${hex}')`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${String(v)}'`;
  if (typeof v === 'boolean') return dialect === 'mssql' ? (v ? '1' : '0') : (v ? 'TRUE' : 'FALSE');
  const s = toText(v);
  if (s.includes('\0')) throw new Error('This text holds a zero byte, which the database cannot store in a text value.');
  // N'...' keeps Unicode on SQL Server whatever the column collation; Oracle uses the database character set.
  if (dialect === 'mssql') return "N'" + s.replace(/'/g, "''") + "'";
  if (s.length > 4000) {
    // Oracle string literals stop at 4,000 bytes: build long text from 1,000-character pieces.
    const parts = [];
    for (let i = 0; i < s.length; i += 1000) parts.push("TO_CLOB('" + s.slice(i, i + 1000).replace(/'/g, "''") + "')");
    return parts.join(' || ');
  }
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Statements for the staged grid edits.
 * target: {schema, table, pk:[column names]}
 * changes: [{kind:'update', key, set} | {kind:'insert', values} | {kind:'delete', key}]
 */
function editStatements(target, changes, dialect) {
  const t = qualified(target.schema, target.table, dialect);
  const where = (key) => Object.keys(key).map((c) => key[c] === null
    ? `${quoteIdent(c, dialect)} IS NULL`
    : `${quoteIdent(c, dialect)} = ${quoteLiteral(key[c], dialect)}`).join(' AND ');
  const out = [];
  for (const ch of changes) {
    if (ch.kind === 'update') {
      const cols = Object.keys(ch.set || {});
      if (!cols.length) continue;
      const set = cols.map((c) => `${quoteIdent(c, dialect)} = ${quoteLiteral(ch.set[c], dialect)}`).join(', ');
      out.push({ sql: `UPDATE ${t} SET ${set} WHERE ${where(ch.key)}`, expect: 1 });
    } else if (ch.kind === 'delete') {
      out.push({ sql: `DELETE FROM ${t} WHERE ${where(ch.key)}`, expect: 1 });
    } else if (ch.kind === 'insert') {
      const cols = Object.keys(ch.values || {});
      if (!cols.length) {
        out.push({ sql: dialect === 'mssql' ? `INSERT INTO ${t} DEFAULT VALUES` : `INSERT INTO ${t} VALUES (DEFAULT)`, expect: 1 });
      } else {
        out.push({ sql: `INSERT INTO ${t} (${cols.map((c) => quoteIdent(c, dialect)).join(', ')}) VALUES (${cols.map((c) => quoteLiteral(ch.values[c], dialect)).join(', ')})`, expect: 1 });
      }
    }
  }
  return out;
}

/**
 * Wrap a SELECT for a server-side sort and filter.
 * sort: {col: 1-based position, desc}, filters: [{name, text}] (column names; case-insensitive contains)
 */
function wrapQuery(sql, dialect, sort, filters) {
  const inner = String(sql).replace(/;\s*$/, '');
  const parts = [dialect === 'mssql' ? `SELECT * FROM (\n${inner}\n) AS zovo_q` : `SELECT * FROM (\n${inner}\n) zovo_q`];
  const f = (filters || []).filter((x) => x && String(x.text || '') !== '');
  if (f.length) {
    const conds = f.map((x) => {
      const col = `zovo_q.${quoteIdent(x.name, dialect)}`;
      // '[' is a LIKE wildcard only on SQL Server; Oracle refuses an escape before a plain character.
      const special = dialect === 'mssql' ? /[\\%_[]/g : /[\\%_]/g;
      const pat = quoteLiteral('%' + String(x.text).replace(special, (c) => '\\' + c) + '%', dialect);
      if (dialect === 'mssql') return `CAST(${col} AS NVARCHAR(MAX)) LIKE ${pat} ESCAPE '\\'`;
      return `UPPER(TO_CHAR(${col})) LIKE UPPER(${pat}) ESCAPE '\\'`;
    });
    parts.push('WHERE ' + conds.join(' AND '));
  }
  if (sort && sort.col) {
    const dir = sort.desc ? 'DESC' : 'ASC';
    parts.push(`ORDER BY ${Number(sort.col)} ${dir}${dialect === 'oracle' ? (sort.desc ? ' NULLS LAST' : ' NULLS FIRST') : ''}`);
  }
  return parts.join('\n');
}

/** One INSERT line for an export. */
function insertLine(table, columns, row, dialect) {
  return `INSERT INTO ${quoteIdent(table, dialect)} (${columns.map((c) => quoteIdent(c, dialect)).join(', ')}) VALUES (${row.map((v) => quoteLiteral(v, dialect)).join(', ')});\n`;
}

/** SELECT * of a table, for "Open table" and export. */
function selectAll(schema, table, dialect, database) {
  return `SELECT * FROM ${database ? quoteIdent(database, dialect) + '.' : ''}${qualified(schema, table, dialect)}`;
}

/** "SELECT TOP 100" (SQL Server) or "FETCH FIRST 100 ROWS ONLY" (Oracle 12c+). */
function selectTop(schema, table, dialect, n = 100) {
  if (dialect === 'mssql') return `SELECT TOP ${n} * FROM ${qualified(schema, table, dialect)};`;
  return `SELECT * FROM ${qualified(schema, table, dialect)}\nFETCH FIRST ${n} ROWS ONLY;`;
}

module.exports = { quoteIdent, qualified, quoteLiteral, editStatements, wrapQuery, insertLine, selectAll, selectTop };

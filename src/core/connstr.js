'use strict';
// Connection settings: parse a pasted connection string, check a form, and show a connection without secrets.
// Passwords and tokens are never part of a saved connection. They live in VS Code SecretStorage.
//
// SQL Server: sqlserver://user@host:1433/db, mssql://..., ADO.NET "Server=host,1433;Database=db;User Id=u;Password=p;
//   Encrypt=True;TrustServerCertificate=True" and JDBC "jdbc:sqlserver://host:1433;databaseName=db;user=u".
// Oracle: Easy Connect "host:1521/service", "user/password@host:1521/service", oracle://user@host:1521/service,
//   JDBC "jdbc:oracle:thin:@host:1521/service" or "jdbc:oracle:thin:@host:1521:SID", or a (DESCRIPTION=...) string.

const DEFAULT_PORT = { mssql: 1433, oracle: 1521 };
const AUTH = ['sql', 'ntlm', 'token'];
const ENCRYPT = ['yes', 'no', 'strict'];
const METHODS = ['easy', 'tns', 'wallet'];

function dec(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function bool(v) {
  return /^(true|yes|1|on|mandatory|strict)$/i.test(String(v || '').trim());
}

/** Split "host,port" / "host:port" / "host\instance" (SQL Server). */
function mssqlServer(s) {
  let host = String(s || '').trim().replace(/^tcp:/i, '');
  let port = DEFAULT_PORT.mssql;
  let instance = '';
  const comma = host.lastIndexOf(',');
  if (comma >= 0) { port = Number(host.slice(comma + 1)); host = host.slice(0, comma); }
  const bs = host.indexOf('\\');
  if (bs >= 0) { instance = host.slice(bs + 1); host = host.slice(0, bs); }
  const colon = host.lastIndexOf(':');
  if (colon > 0 && !/\]$/.test(host) && host.indexOf(':') === colon) { port = Number(host.slice(colon + 1)); host = host.slice(0, colon); }
  if (host === '.' || /^\(local\)$/i.test(host)) host = 'localhost';
  return { host, port, instance };
}

/**
 * @returns {object} connection fields (type, host, port, user, password, database, ...) or throws a clear Error.
 */
function parseConnectionString(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a connection string, for example sqlserver://sa@localhost:1433/master or localhost:1521/FREEPDB1');
  if (/^(mongodb|postgres|postgresql|mysql|mariadb|sqlite)[:+]/i.test(raw)) {
    throw new Error('This extension connects to SQL Server, Azure SQL and Oracle. For PostgreSQL, MySQL or SQLite use the Postgres & MySQL client by Zovo.');
  }
  // ADO.NET / ODBC style key=value list
  if (/^[^=;]+=[^;]*;/.test(raw) && /(server|data source|address)\s*=/i.test(raw)) {
    const kv = {};
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().replace(/^\{(.*)\}$/, '$1');
    }
    const srv = mssqlServer(kv.server || kv['data source'] || kv.address || kv.addr || '');
    const integrated = bool(kv['integrated security']) || /^sspi$/i.test(kv['integrated security'] || '') || bool(kv.trusted_connection);
    const user = kv['user id'] || kv.uid || kv.user || '';
    return {
      type: 'mssql', ...srv,
      database: kv.database || kv['initial catalog'] || '',
      user: user.includes('\\') ? user.split('\\')[1] : user,
      domain: user.includes('\\') ? user.split('\\')[0] : '',
      password: kv.password || kv.pwd || '',
      auth: integrated || user.includes('\\') ? 'ntlm' : 'sql',
      encrypt: kv.encrypt === undefined ? 'yes' : (/^strict$/i.test(kv.encrypt) ? 'strict' : (bool(kv.encrypt) ? 'yes' : 'no')),
      trustServerCertificate: bool(kv.trustservercertificate || kv['trust server certificate']),
    };
  }
  let m = /^jdbc:sqlserver:\/\/([^;]*)(;.*)?$/i.exec(raw);
  if (m) {
    const kv = {};
    for (const part of (m[2] || '').split(';')) { const i = part.indexOf('='); if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
    const srv = mssqlServer(m[1].replace(/:(\d+)$/, ',$1'));
    if (kv.instancename) srv.instance = kv.instancename;
    if (kv.portnumber) srv.port = Number(kv.portnumber);
    return {
      type: 'mssql', ...srv, database: kv.databasename || kv.database || '', user: kv.user || kv.username || '', password: kv.password || '',
      auth: bool(kv.integratedsecurity) ? 'ntlm' : 'sql', domain: kv.domain || '',
      encrypt: kv.encrypt === undefined ? 'yes' : (/^strict$/i.test(kv.encrypt) ? 'strict' : (bool(kv.encrypt) ? 'yes' : 'no')),
      trustServerCertificate: bool(kv.trustservercertificate),
    };
  }
  m = /^(sqlserver|mssql|azuresql):\/\/(.*)$/i.exec(raw);
  if (m) {
    const u = urlParts(m[2], DEFAULT_PORT.mssql);
    const p = new URLSearchParams(u.query);
    const srv = mssqlServer(u.hostPort.replace(/:(\d+)$/, ',$1'));
    return {
      type: 'mssql', ...srv, user: u.user, password: u.password, database: u.path || p.get('database') || '',
      auth: p.get('auth') && AUTH.includes(p.get('auth')) ? p.get('auth') : 'sql', domain: p.get('domain') || '',
      encrypt: p.get('encrypt') ? (/^strict$/i.test(p.get('encrypt')) ? 'strict' : (bool(p.get('encrypt')) ? 'yes' : 'no')) : 'yes',
      trustServerCertificate: bool(p.get('trustServerCertificate') || p.get('trustservercertificate')),
    };
  }
  // Oracle
  m = /^jdbc:oracle:thin:(?:([^/@]*)(?:\/([^@]*))?)?@(.*)$/i.exec(raw);
  if (m) return { ...oracleTarget(m[3].replace(/^\/\//, '')), user: m[1] || '', password: m[2] || '' };
  m = /^oracle:\/\/(.*)$/i.exec(raw);
  if (m) {
    const u = urlParts(m[1], DEFAULT_PORT.oracle);
    const hp = u.hostPort;
    const c = hp.lastIndexOf(':');
    return { type: 'oracle', method: 'easy', host: c > 0 ? hp.slice(0, c) : hp, port: c > 0 ? Number(hp.slice(c + 1)) : 1521, service: u.path, user: u.user, password: u.password };
  }
  // user/password@target (SQL*Plus style)
  m = /^([^/@\s(]+)(?:\/([^@]*))?@(.+)$/.exec(raw);
  if (m && !/^[a-z]+:\/\//i.test(raw)) return { ...oracleTarget(m[3]), user: m[1], password: m[2] || '' };
  if (/^\(\s*DESCRIPTION/i.test(raw) || /^[\w.-]+(:\d+)?\/[\w.$#-]+$/.test(raw) || /^[\w.-]+:\d+:[\w$#]+$/.test(raw)) return oracleTarget(raw);
  throw new Error('This connection string is not recognised. Use sqlserver://user@host:1433/db, an ADO.NET string (Server=...;Database=...), or an Oracle Easy Connect string such as host:1521/FREEPDB1.');
}

function urlParts(rest0, defPort) {
  let rest = rest0;
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  let auth = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) { auth = rest.slice(0, at); rest = rest.slice(at + 1); }
  const slash = rest.indexOf('/');
  const hostPort = slash >= 0 ? rest.slice(0, slash) : rest;
  const p = slash >= 0 ? dec(rest.slice(slash + 1)) : '';
  let user = '';
  let password = '';
  if (auth) { const c = auth.indexOf(':'); user = dec(c >= 0 ? auth.slice(0, c) : auth); password = c >= 0 ? dec(auth.slice(c + 1)) : ''; }
  return { hostPort: dec(hostPort) || `localhost:${defPort}`, path: p, user, password, query };
}

function oracleTarget(t) {
  const s = String(t).trim();
  if (/^\(\s*DESCRIPTION/i.test(s)) return { type: 'oracle', method: 'easy', connectString: s };
  let m = /^([\w.-]+|\[[^\]]+\])(?::(\d+))?\/([\w.$#-]+)(?::[\w]+)?$/.exec(s);
  if (m) return { type: 'oracle', method: 'easy', host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2] || 1521), service: m[3] };
  m = /^([\w.-]+):(\d+):([\w$#]+)$/.exec(s);
  if (m) return { type: 'oracle', method: 'easy', host: m[1], port: Number(m[2]), sid: m[3] };
  if (/^[\w.$#-]+$/.test(s)) return { type: 'oracle', method: 'tns', tnsAlias: s };
  return { type: 'oracle', method: 'easy', connectString: s };
}

/** Check a connection form. Returns a list of problems. */
function validate(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['No connection settings.'];
  if (!['mssql', 'oracle'].includes(c.type)) errs.push('Pick SQL Server or Oracle.');
  if (!String(c.name || '').trim()) errs.push('Give the connection a name.');
  if (c.type === 'mssql') {
    if (!String(c.host || '').trim()) errs.push('Type the server name or address.');
    if (!c.instance) {
      const p = Number(c.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) errs.push('The port must be a number from 1 to 65535.');
    }
    if (c.auth && !AUTH.includes(c.auth)) errs.push('Unknown authentication type.');
    if (c.encrypt && !ENCRYPT.includes(c.encrypt)) errs.push('Unknown encryption setting.');
    if (c.auth === 'ntlm' && !String(c.user || '').trim()) errs.push('Windows (NTLM) login needs the user name (and the domain).');
  } else if (c.type === 'oracle') {
    const method = c.method || 'easy';
    if (!METHODS.includes(method)) errs.push('Unknown Oracle connection method.');
    if (method === 'easy' && !c.connectString) {
      if (!String(c.host || '').trim()) errs.push('Type the host name or address.');
      const p = Number(c.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) errs.push('The port must be a number from 1 to 65535.');
      if (!String(c.service || '').trim() && !String(c.sid || '').trim()) errs.push('Type the service name (for example FREEPDB1) or the SID.');
    }
    if ((method === 'tns' || method === 'wallet') && !String(c.tnsAlias || '').trim()) errs.push('Type or pick the TNS alias.');
    if (!String(c.user || '').trim()) errs.push('Type the Oracle user name.');
  }
  return errs;
}

/** A short address to show in the tree and the status bar. Never holds a password. */
function displayUrl(c) {
  if (c.type === 'mssql') {
    const user = c.auth === 'token' ? 'access token' : (c.auth === 'ntlm' ? `${c.domain ? `${c.domain}\\` : ''}${c.user}` : c.user);
    return `sqlserver://${user ? `${user}@` : ''}${c.host}${c.instance ? `\\${c.instance}` : `:${c.port}`}/${c.database || ''}`;
  }
  if (c.method === 'tns' || c.method === 'wallet') return `${c.user ? `${c.user}@` : ''}${c.tnsAlias}${c.method === 'wallet' ? ' (wallet)' : ''}`;
  if (c.connectString) return `${c.user ? `${c.user}@` : ''}${c.connectString.slice(0, 80)}`;
  return `${c.user ? `${c.user}@` : ''}${c.host}:${c.port}${c.sid ? `:${c.sid}` : `/${c.service || ''}`}`;
}

module.exports = { parseConnectionString, validate, displayUrl, mssqlServer, oracleTarget, DEFAULT_PORT, AUTH, ENCRYPT, METHODS };

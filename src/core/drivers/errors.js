'use strict';
// Turns driver errors into one clear sentence. Keeps the server's own text and, when there is one,
// the place of the error in the statement (SQL Server: line in the batch; Oracle: character offset).
// Never puts a password or token in a message.

function where(cfg) {
  if (!cfg) return 'the server';
  if (cfg.connectString) return cfg.connectString;
  if (cfg.tnsAlias) return `TNS alias ${cfg.tnsAlias}`;
  return `${cfg.host}${cfg.instance ? `\\${cfg.instance}` : (cfg.port ? `:${cfg.port}` : '')}`;
}

const LOST = /ECONNRESET|EPIPE|ESOCKET|Connection lost|connection was broken|closed the connection|NJS-500|NJS-501|NJS-003|ORA-03113|ORA-03114|ORA-03135|ORA-02396|DPI-1080|socket hang up|Connection is closed|Final state|not connected/i;

/** True when the error means the connection is gone (the next run reconnects). */
function isConnectionLost(e) {
  if (!e) return false;
  return LOST.test(`${e.code || ''} ${e.message || ''}`);
}

function friendlyError(e, cfg, dialect, sql) {
  if (!e) return new Error('Unknown error.');
  if (e.friendly) return e;
  const code = String(e.code || '');
  const num = Number(e.number || e.errorNum || 0);
  let raw = String(e.message || e);
  if (e.errors && e.errors.length && /AggregateError|^$/.test(raw)) raw = e.errors.map((x) => x.message).join(' ');
  let msg = raw;
  const ora = (/ORA-(\d{5})/.exec(raw) || [])[1];
  const njs = (/NJS-(\d{3})/.exec(raw) || [])[1];
  const cause = e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code) || '');
  if (/^Failed to connect to /.test(raw) && !/in \d+ms/.test(raw)) {
    // tedious wraps every connect failure in "Failed to connect to host:port - <reason>".
    if (cause === 'ECONNREFUSED' || /ECONNREFUSED|Could not connect \(sequence\)/.test(raw)) msg = `Could not connect to ${where(cfg)}: the connection was refused. Check that SQL Server is running, TCP/IP is on and the host and port are right. (${raw})`;
    else if (cause === 'ENOTFOUND' || /getaddrinfo/.test(raw)) msg = `The host name "${cfg && cfg.host}" was not found. Check the spelling, or your VPN.`;
    else msg = `Could not connect to ${where(cfg)}. (${raw})`;
  } else if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(raw) || njs === '503' || ora === '12541') msg = `Could not connect to ${where(cfg)}: the connection was refused. Check that the server is running and the host and port are right. (${raw.split('\n')[0]})`;
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo ENOTFOUND/.test(raw)) msg = `The host name "${cfg && cfg.host}" was not found. Check the spelling, or your VPN.`;
  else if (code === 'ETIMEOUT' || code === 'ETIMEDOUT' || njs === '510' || /Failed to connect .* in \d+ms|timed out|ETIMEDOUT/i.test(raw) && !/statement/i.test(raw)) msg = `No answer from ${where(cfg)} in time. Check the host, the port and any firewall or VPN. (${raw.split('\n')[0]})`;
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') msg = `${where(cfg)} cannot be reached from this computer (no route). Check your network or VPN.`;
  else if (num === 18456 || code === 'ELOGIN' && /Login failed/i.test(raw)) msg = `SQL Server refused the login${cfg && cfg.user ? ` for "${cfg.user}"` : ''}. Check the user name, the password and the authentication type (SQL login or Windows). (${raw})`;
  else if (ora === '01017') msg = `Oracle refused the user name or password${cfg && cfg.user ? ` for "${cfg.user}"` : ''}. Edit the connection to fix them. (${raw.split('\n')[0]})`;
  else if (ora === '28000') msg = `The Oracle account is locked. Ask the DBA to unlock it. (${raw.split('\n')[0]})`;
  else if (ora === '28001') msg = `The Oracle password has expired. Change it in another tool, then edit the connection. (${raw.split('\n')[0]})`;
  else if (ora === '12514' || njs === '518' || ora === '12505') msg = `The listener at ${where(cfg)} does not know this service name or SID. Check the service name (for example FREEPDB1 or ORCLPDB1). (${raw.split('\n')[0]})`;
  else if (num === 4060) msg = `The database does not exist on ${where(cfg)}, or this login has no access to it. (${raw})`;
  else if (code === 'ECANCEL' || num === 3980 || ora === '01013' || /Canceled|cancelled by user|user requested cancel/i.test(raw)) msg = 'The query was cancelled.';
  else if (/self[- ]signed certificate|certificate verify failed|unable to verify the first certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(raw) || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') msg = `The server's TLS certificate is not trusted (${raw.split('\n')[0]}). For a server with a self-signed certificate, turn on "Trust server certificate" in the connection.`;
  else if (code === 'EENCRYPT' || /encryption/i.test(raw) && /not support|required/i.test(raw)) msg = `The server and this connection do not agree on encryption. Edit the connection and change "Encrypt". (${raw})`;
  else if (isConnectionLost(e)) msg = `The connection to ${where(cfg)} was lost (${raw.split('\n')[0]}). Run the query again: it reconnects.`;
  const out = new Error(msg.trim());
  out.friendly = true;
  out.code = code || (ora ? `ORA-${ora}` : (njs ? `NJS-${njs}` : ''));
  out.lost = !/^Failed to connect to /.test(raw) && isConnectionLost(e);
  if (e.beforeSend) out.beforeSend = true;
  // Place of the error in the statement, for the editor marker.
  if (dialect === 'mssql' && Number(e.lineNumber) > 0) out.line = Number(e.lineNumber) - 1;
  else if (dialect === 'oracle' && typeof e.offset === 'number' && e.offset > 0) out.position = e.offset;
  if (typeof e.plsqlLine === 'number') { out.line = e.plsqlLine - 1; if (typeof e.plsqlCol === 'number') out.column = e.plsqlCol - 1; }
  return out;
}

module.exports = { friendlyError, isConnectionLost };

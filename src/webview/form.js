// Connection form for SQL Server / Azure SQL and Oracle. Paste a connection string or fill the fields.
// The password, token or wallet password goes to the host only on Test or Save, and the host keeps it in
// VS Code SecretStorage, never in settings.
import { h } from './dom.js';

export function startForm(vscode, app, data) {
  const c = Object.assign({
    type: 'mssql', name: '', host: 'localhost', port: 1433, instance: '', user: '', domain: '', auth: 'sql', database: '', encrypt: 'yes', trustServerCertificate: false,
    method: 'easy', service: '', sid: '', connectString: '', tnsAlias: '', configDir: '', walletDir: '', privilege: '', readOnly: false, savePassword: true,
  }, data.conn || {});
  const editing = !!(data.conn && data.conn.id);
  const hasPassword = !!data.hasPassword;

  const field = (label, input, help) => h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, help ? h('span', { class: 'help' }, help) : null);
  const inp = (name, attrs = {}) => {
    const el = h('input', { name, id: `f-${name}`, type: 'text', spellcheck: 'false', ...attrs });
    el.value = c[name] === undefined || c[name] === null ? '' : String(c[name]);
    return el;
  };
  const sel = (name, options) => {
    const el = h('select', { id: `f-${name}` });
    for (const [v, l] of options) { const o = h('option', { value: v }, l); if (String(c[name]) === v) o.selected = true; el.append(o); }
    return el;
  };
  const seg = (label, items, value, onPick) => {
    const box = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
    for (const [id, text] of items) {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(value === id), class: 'seg-btn' + (value === id ? ' on' : ''), 'data-v': id }, text);
      b.addEventListener('click', () => onPick(id));
      box.append(b);
    }
    box.set = (v) => { for (const b of box.children) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } };
    return box;
  };

  const typeSel = seg('Database', [['mssql', 'SQL Server / Azure SQL'], ['oracle', 'Oracle Database']], c.type, (t) => setType(t));
  const conn = h('input', { type: 'text', id: 'f-url', spellcheck: 'false' });
  const connBtn = h('button', { type: 'button', class: 'btn' }, 'Fill from string');
  const name = inp('name', { placeholder: 'My database' });

  // SQL Server fields
  const host = inp('host');
  const port = inp('port', { type: 'number', min: '1', max: '65535' });
  const instance = inp('instance', { placeholder: 'optional, for a named instance (uses SQL Browser)' });
  const auth = sel('auth', [['sql', 'SQL login (user and password)'], ['ntlm', 'Windows login (NTLM, domain user)'], ['token', 'Azure AD access token']]);
  const domain = inp('domain', { placeholder: 'CONTOSO' });
  const database = inp('database', { placeholder: 'optional: the login default' });
  const encrypt = sel('encrypt', [['yes', 'Encrypt (TLS)'], ['strict', 'Strict (TDS 8.0)'], ['no', 'Off (local servers only)']]);
  const trust = h('input', { type: 'checkbox', id: 'f-trust' });
  trust.checked = !!c.trustServerCertificate;

  // Oracle fields
  const methodSel = seg('Oracle connection', [['easy', 'Host and service'], ['tns', 'TNS alias (tnsnames.ora)'], ['wallet', 'Wallet (Autonomous DB)']], c.method || 'easy', (m) => setMethod(m));
  const ohost = h('input', { type: 'text', id: 'f-ohost', spellcheck: 'false' });
  ohost.value = c.type === 'oracle' ? (c.host || '') : 'localhost';
  const oport = h('input', { type: 'number', id: 'f-oport', min: '1', max: '65535' });
  oport.value = String(c.type === 'oracle' ? (c.port || 1521) : 1521);
  const service = inp('service', { placeholder: 'FREEPDB1, ORCLPDB1, XEPDB1 …' });
  const sid = inp('sid', { placeholder: 'only for old databases without a service name' });
  const connectString = inp('connectString', { placeholder: 'optional: a full (DESCRIPTION=...) string instead of host and service' });
  const tnsAlias = inp('tnsAlias', { placeholder: 'MYDB_HIGH', list: 'tns-aliases' });
  const aliasList = h('datalist', { id: 'tns-aliases' });
  const configDir = inp('configDir', { placeholder: 'empty: the TNS_ADMIN folder' });
  const configBtn = h('button', { type: 'button', class: 'btn' }, 'Browse…');
  const walletDir = inp('walletDir', { placeholder: 'empty: the same folder as tnsnames.ora' });
  const walletBtn = h('button', { type: 'button', class: 'btn' }, 'Browse…');
  const walletPw = h('input', { type: 'password', id: 'f-walletPassword', autocomplete: 'new-password', placeholder: 'only if ewallet.pem is encrypted' });
  const privilege = sel('privilege', [['', 'Normal user'], ['SYSDBA', 'SYSDBA'], ['SYSOPER', 'SYSOPER'], ['SYSBACKUP', 'SYSBACKUP'], ['SYSDG', 'SYSDG'], ['SYSKM', 'SYSKM']]);

  // Shared
  const user = inp('user', { autocomplete: 'off' });
  const password = h('input', { type: 'password', id: 'f-password', autocomplete: 'new-password', placeholder: editing && hasPassword ? 'saved (leave empty to keep it)' : '' });
  const pwLabel = h('span', { class: 'label' }, 'Password');
  const savePw = h('input', { type: 'checkbox', id: 'f-savePassword' });
  savePw.checked = c.savePassword !== false;
  const ro = h('input', { type: 'checkbox', id: 'f-readOnly' });
  ro.checked = !!c.readOnly;

  const userRow = h('div', { class: 'row2' }, field('User', user), h('label', { class: 'field' }, pwLabel, password));
  const mssqlBox = h('div', { class: 'group' },
    h('div', { class: 'row2' }, field('Server', host, 'Host name or address. Azure SQL: yourserver.database.windows.net'), field('Port', port)),
    field('Instance name', instance),
    h('div', { class: 'row2' }, field('Authentication', auth), field('Domain', domain, 'Windows login only')),
    field('Database', database),
    h('div', { class: 'row2' }, field('Encryption', encrypt), h('label', { class: 'check' }, trust, ' Trust the server certificate (self-signed, local servers)')));
  const easyBox = h('div', {},
    h('div', { class: 'row2' }, field('Host', ohost), field('Port', oport)),
    h('div', { class: 'row2' }, field('Service name', service), field('SID', sid)),
    field('Full connect descriptor', connectString));
  const tnsBox = h('div', {},
    h('div', { class: 'row-ca' }, field('Folder with tnsnames.ora', configDir), configBtn),
    field('TNS alias', tnsAlias), aliasList);
  const walletBox = h('div', {},
    h('div', { class: 'row-ca' }, field('Wallet folder (holds ewallet.pem)', walletDir, 'Unzip the wallet you downloaded from the Oracle Cloud console.'), walletBtn),
    field('Wallet password', walletPw));
  const oracleBox = h('div', { class: 'group' }, methodSel, easyBox, tnsBox, walletBox, field('Connect as', privilege));

  const status = h('div', { class: 'form-status', role: 'status', 'aria-live': 'polite' });
  const test = h('button', { type: 'button', class: 'btn' }, 'Test connection');
  const save = h('button', { type: 'button', class: 'btn primary' }, editing ? 'Save' : 'Save and connect');
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');

  const form = h('form', { class: 'conn-form', autocomplete: 'off' },
    h('h1', {}, editing ? `Edit ${c.name}` : 'New connection'),
    h('p', { class: 'lead' }, 'Free, no sign-in. This extension talks only to the server you type here: no telemetry, no update check, no license server. Nothing connects until you expand the connection or run a query.'),
    typeSel,
    h('div', { class: 'url-row' }, field('Paste a connection string', conn), connBtn),
    field('Name', name),
    mssqlBox, oracleBox,
    userRow,
    h('label', { class: 'check' }, savePw, ' Save the password in VS Code\'s secret storage (otherwise it is asked once per window)'),
    h('label', { class: 'check' }, ro, ' Read-only: block every change on this connection (the server enforces it: Oracle read-only session, SQL Server rollback of each batch)'),
    h('div', { class: 'buttons' }, test, save, cancel),
    status);
  app.append(form);

  function setType(t) {
    c.type = t;
    typeSel.set(t);
    mssqlBox.classList.toggle('hidden', t !== 'mssql');
    oracleBox.classList.toggle('hidden', t !== 'oracle');
    conn.placeholder = t === 'mssql' ? 'Server=host,1433;Database=db;User Id=sa;Encrypt=True  or  sqlserver://sa@host:1433/db' : 'host:1521/FREEPDB1  or  user@host:1521/service  or  jdbc:oracle:thin:@host:1521/service';
    setAuth();
  }
  function setMethod(m) {
    c.method = m;
    methodSel.set(m);
    easyBox.classList.toggle('hidden', m !== 'easy');
    tnsBox.classList.toggle('hidden', m === 'easy');
    walletBox.classList.toggle('hidden', m !== 'wallet');
  }
  function setAuth() {
    const token = c.type === 'mssql' && auth.value === 'token';
    pwLabel.textContent = token ? 'Access token' : 'Password';
    user.disabled = token;
    domain.disabled = !(c.type === 'mssql' && auth.value === 'ntlm');
  }
  auth.addEventListener('change', setAuth);
  setType(c.type);
  setMethod(c.method || 'easy');

  connBtn.addEventListener('click', fill);
  conn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fill(); } });
  conn.addEventListener('paste', () => setTimeout(fill, 0));
  function fill() {
    if (!conn.value.trim()) return;
    vscode.postMessage({ type: 'parse', text: conn.value });
  }
  function applyParsed(p) {
    setType(p.type);
    if (p.type === 'mssql') {
      host.value = p.host || ''; port.value = String(p.port || 1433); instance.value = p.instance || ''; database.value = p.database || '';
      auth.value = p.auth || 'sql'; domain.value = p.domain || ''; encrypt.value = p.encrypt || 'yes'; trust.checked = !!p.trustServerCertificate;
    } else {
      setMethod(p.method || 'easy');
      ohost.value = p.host || ''; oport.value = String(p.port || 1521); service.value = p.service || ''; sid.value = p.sid || '';
      connectString.value = p.connectString || ''; tnsAlias.value = p.tnsAlias || '';
    }
    if (p.user) user.value = p.user;
    if (p.password) password.value = p.password;
    if (!name.value) name.value = p.database || p.service || p.tnsAlias || p.host || 'Database';
    setAuth();
    conn.value = '';
    say('Filled from the connection string. The password stays in this form until you save.', 'ok');
  }

  function collect() {
    const base = { id: c.id, type: c.type, name: name.value.trim(), user: user.value.trim(), readOnly: ro.checked, savePassword: savePw.checked };
    if (c.type === 'mssql') {
      return { ...base, host: host.value.trim(), port: Number(port.value) || 1433, instance: instance.value.trim(), auth: auth.value, domain: domain.value.trim(), database: database.value.trim(), encrypt: encrypt.value, trustServerCertificate: trust.checked };
    }
    return {
      ...base, method: c.method, host: ohost.value.trim(), port: Number(oport.value) || 1521, service: service.value.trim(), sid: sid.value.trim(), connectString: connectString.value.trim(),
      tnsAlias: tnsAlias.value.trim(), configDir: configDir.value.trim(), walletDir: walletDir.value.trim(), privilege: privilege.value,
    };
  }
  const pw = () => (password.value === '' && editing && hasPassword ? undefined : password.value);
  const wpw = () => (c.type === 'oracle' && c.method === 'wallet' && walletPw.value !== '' ? walletPw.value : undefined);

  test.addEventListener('click', () => { say('Connecting…', ''); vscode.postMessage({ type: 'test', conn: collect(), password: pw(), walletPassword: wpw() }); });
  save.addEventListener('click', () => { say('Saving…', ''); vscode.postMessage({ type: 'save', conn: collect(), password: pw(), walletPassword: wpw() }); });
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  configBtn.addEventListener('click', () => vscode.postMessage({ type: 'browse', what: 'tns' }));
  walletBtn.addEventListener('click', () => vscode.postMessage({ type: 'browse', what: 'wallet' }));
  form.addEventListener('submit', (e) => e.preventDefault());

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'browsed') {
      if (m.what === 'wallet') walletDir.value = m.path; else configDir.value = m.path;
      if (m.aliases && m.aliases.length) {
        aliasList.textContent = '';
        for (const a of m.aliases) aliasList.append(h('option', { value: a }));
        if (!tnsAlias.value) tnsAlias.value = m.aliases[0];
        say(`Found ${m.aliases.length} aliases in tnsnames.ora: ${m.aliases.slice(0, 8).join(', ')}`, 'ok');
      }
    }
    if (m.type === 'parsed') { if (m.ok) applyParsed(m.conn); else say(m.message, 'bad'); }
    if (m.type === 'tested' || m.type === 'saved') say(m.message, m.ok ? 'ok' : 'bad');
  });

  function say(text, cls) {
    status.textContent = text;
    status.className = `form-status ${cls}`;
  }
  (editing ? name : conn).focus();
  vscode.postMessage({ type: 'ready' });
}

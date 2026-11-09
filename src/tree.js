'use strict';
// The Database Explorer: connections > databases > schemas > tables and views > columns and indexes.
// Every level loads when it is expanded (one query per level), so a schema with 5,000 tables opens fast.

const { displayUrl } = require('./core/connstr');

const LABEL = { mssql: 'SQL Server', oracle: 'Oracle Database' };

function fmtCount(n) {
  if (n === null || n === undefined || n < 0) return '';
  if (n < 1000) return `${n} rows`;
  if (n < 1e6) return `~${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K rows`;
  return `~${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M rows`;
}

class ExplorerProvider {
  constructor(vscode, store, sessions) {
    this.vscode = vscode;
    this.store = store;
    this.sessions = sessions;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    store.onDidChange(() => this.refresh());
    this.errors = new Map();
  }

  refresh(node) {
    this.emitter.fire(node || undefined);
  }

  getTreeItem(node) {
    const v = this.vscode;
    const TI = v.TreeItemCollapsibleState;
    const it = new v.TreeItem(node.label, node.leaf ? TI.None : (node.expanded ? TI.Expanded : TI.Collapsed));
    it.contextValue = node.kind + (node.readOnly ? ':ro' : '');
    if (node.description) it.description = node.description;
    if (node.tooltip) it.tooltip = node.tooltip;
    // Screen readers read the name and description, not the multi-line tooltip.
    it.accessibilityInformation = { label: node.description ? `${node.label}, ${node.description}` : String(node.label) };
    if (node.icon) it.iconPath = new v.ThemeIcon(node.icon, node.iconColor ? new v.ThemeColor(node.iconColor) : undefined);
    if (node.id) it.id = node.id;
    if (node.kind === 'table' || node.kind === 'view') it.command = { command: 'zovoOra.openTable', title: 'Open', arguments: [node] };
    if (['procedure', 'function', 'package'].includes(node.kind)) it.command = { command: 'zovoOra.scriptCreate', title: 'Script as CREATE', arguments: [node] };
    if (node.kind === 'error') it.command = { command: 'zovoOra.showError', title: 'Show error', arguments: [node] };
    if (node.kind === 'empty' && node.conn === undefined) it.command = { command: 'zovoOra.addConnection', title: 'Add' };
    return it;
  }

  async getChildren(node) {
    try {
      return await this.children(node);
    } catch (e) {
      if (e && e.cancelled) return [];
      const msg = (e && e.message) || String(e);
      return [{ kind: 'error', label: 'Could not load: ' + msg.slice(0, 120), tooltip: msg, message: msg, icon: 'error', iconColor: 'errorForeground', leaf: true, id: `${node ? node.id : 'root'}/error/${Date.now()}` }];
    }
  }

  async children(node) {
    if (!node) {
      const open = this.sessions.openIds();
      return this.store.list().map((c) => ({
        kind: 'connection', id: `c/${c.id}`, conn: c.id, type: c.type, label: c.name,
        description: (c.readOnly ? 'read-only · ' : '') + (c.type === 'mssql' ? `SQL Server · ${c.host}${c.instance ? `\\${c.instance}` : ''}` : `Oracle · ${c.tnsAlias || c.service || c.sid || c.host || ''}`),
        tooltip: `${LABEL[c.type]}\n${displayUrl(c)}${c.readOnly ? '\nRead-only' : ''}`,
        icon: 'database', iconColor: open.has(c.id) ? 'charts.green' : undefined, readOnly: c.readOnly,
      }));
    }
    const c = this.store.get(node.conn);
    if (!c) return [];
    if (node.kind === 'connection') {
      const s = await this.sessions.get(c.id, '');
      const info = await s.open();
      if (c.type === 'oracle') return this.schemaNodes(c, s, node, '', info.schema);
      const dbs = await s.databases();
      const current = info.database;
      return dbs.map((d) => ({
        kind: 'database', id: `${node.id}/d/${d}`, conn: c.id, type: c.type, database: d, label: d,
        description: d === current ? 'default' : '', icon: 'database', expanded: d === current && dbs.length <= 20,
        sessionDb: d === current ? '' : d,
      }));
    }
    if (node.kind === 'database') {
      const s = await this.sessions.get(c.id, node.sessionDb);
      return this.schemaNodes(c, s, node, node.sessionDb, 'dbo');
    }
    if (node.kind === 'schema') return this.objectFolders(c, node);
    if (node.kind === 'folder') {
      return node.items.map((t) => ({
        kind: t.kind, id: `${node.id}/${t.name}`, conn: c.id, type: c.type, database: node.database, sessionDb: node.sessionDb, schema: node.schema,
        table: t.kind === 'table' || t.kind === 'view' ? t.name : undefined, name: t.name,
        label: t.name, description: t.kind === 'table' || t.kind === 'view' ? fmtCount(t.rows) : (t.invalid ? 'invalid' : ''),
        icon: { view: 'eye', table: 'table', procedure: 'symbol-method', function: 'symbol-function', package: 'package' }[t.kind] || 'symbol-misc',
        iconColor: t.invalid ? 'errorForeground' : undefined, readOnly: c.readOnly, leaf: !(t.kind === 'table' || t.kind === 'view'),
      }));
    }
    if (node.kind === 'table' || node.kind === 'view') {
      const s = await this.sessions.get(c.id, node.sessionDb);
      const cols = await s.columns(node.schema, node.table);
      const out = cols.map((col) => ({
        kind: 'column', id: `${node.id}/c/${col.name}`, conn: c.id, label: col.name, leaf: true,
        description: `${col.type}${col.notNull ? ' not null' : ''}${col.pk ? ' · PK' : ''}`,
        tooltip: `${col.name} ${col.type}${col.notNull ? ' NOT NULL' : ''}${col.default != null ? `\nDEFAULT ${col.default}` : ''}${col.pk ? '\nPrimary key' : ''}`,
        icon: col.pk ? 'key' : 'symbol-field', name: col.name,
      }));
      if (node.kind === 'table') {
        out.push({ kind: 'indexes', id: `${node.id}/i`, conn: c.id, type: c.type, sessionDb: node.sessionDb, schema: node.schema, table: node.table, label: 'Indexes', icon: 'list-tree' });
      }
      return out;
    }
    if (node.kind === 'indexes') {
      const s = await this.sessions.get(c.id, node.sessionDb);
      const idx = await s.indexes(node.schema, node.table);
      if (!idx.length) return [{ kind: 'empty', conn: c.id, label: 'No indexes', leaf: true, id: `${node.id}/none` }];
      return idx.map((i) => ({ kind: 'index', id: `${node.id}/${i.name}`, conn: c.id, label: i.name, description: i.pk ? 'primary key' : (i.unique ? 'unique' : ''), tooltip: i.def, icon: i.pk ? 'key' : 'symbol-key', leaf: true, name: i.name }));
    }
    return [];
  }

  async schemaNodes(c, s, parent, sessionDb, preferred) {
    const schemas = await s.schemas();
    return schemas.map((sc) => ({
      kind: 'schema', id: `${parent.id}/s/${sc.name}`, conn: c.id, type: c.type, database: parent.database, sessionDb, schema: sc.name,
      label: sc.name, description: sc.count === null ? '' : `${sc.count} tables and views`, icon: 'symbol-namespace',
      expanded: sc.name === preferred && schemas.length <= 30 && (sc.count === null || sc.count <= 300),
    }));
  }

  /** Tables, Views, Procedures, Functions (and Packages on Oracle) of one schema: two queries. */
  async objectFolders(c, parent) {
    const s = await this.sessions.get(c.id, parent.sessionDb);
    const [all, routines] = await Promise.all([s.tables(parent.schema), s.routines(parent.schema).catch(() => [])]);
    const base = { conn: c.id, type: c.type, database: parent.database, sessionDb: parent.sessionDb, schema: parent.schema };
    const groups = [
      ['tables', 'Tables', all.filter((t) => t.kind === 'table'), true],
      ['views', 'Views', all.filter((t) => t.kind === 'view')],
      ['procedures', 'Procedures', routines.filter((r) => r.kind === 'procedure')],
      ['functions', 'Functions', routines.filter((r) => r.kind === 'function')],
      ['packages', 'Packages', routines.filter((r) => r.kind === 'package')],
    ];
    const out = [];
    for (const [key, label, items, always] of groups) {
      if (!items.length && !always) continue;
      out.push({ ...base, kind: 'folder', id: `${parent.id}/${key}`, label, description: String(items.length), icon: 'folder', items, expanded: key === 'tables' && items.length <= 200 });
    }
    return out;
  }

  // The green "connected" icon shows on the next refresh of the list. No extra refresh here: a refresh would
  // read every expanded level again.
  refreshIcon() {}
}

module.exports = { ExplorerProvider, fmtCount };

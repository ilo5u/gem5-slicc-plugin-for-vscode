'use strict';

const vscode = require('vscode');
const { WorkspaceIndex, relativeUri, directory, isWithin } = require('./core/index');
const { ExternalTypes } = require('./core/build-scope');
const { DebugFlags } = require('./core/debug-flags');
const { isSliccDocument } = require('./languages');

class Workspace {
  constructor(context) {
    this.index = new WorkspaceIndex(); this.documents = new Map(); this.timers = new Map(); this.disposed = false;
    this.dependencyWatchers = new Map(); this.includeWatchers = []; this.globalLoads = new Map();
    this.change = new vscode.EventEmitter(); this.onDidChange = this.change.event;
    this.output = vscode.window.createOutputChannel('SLICC');
    this.external = new ExternalTypes({
      read: uri => this.read(uri),
      projectRoots: () => (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString().replace(/\/?$/, '/')),
      exists: async uri => { try { await vscode.workspace.fs.stat(vscode.Uri.parse(uri)); return true; } catch { return false; } },
      list: async uri => { try { return (await vscode.workspace.fs.readDirectory(vscode.Uri.parse(uri))).map(([name, type]) => ({ name, directory: !!(type & vscode.FileType.Directory), symlink: !!(type & vscode.FileType.SymbolicLink) })); } catch { return undefined; } },
      watch: dependencies => this.watchDependencies(dependencies)
    }, this.index);
    this.debugFlags = new DebugFlags(this.external);
    const sliccWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sm,slicc}');
    const cppWatcher = vscode.workspace.createFileSystemWatcher('**/*.{h,hh,hpp,hxx,c,cc,cpp,cxx}');
    const buildWatcher = vscode.workspace.createFileSystemWatcher('**/{Kconfig,SConscript,SConsopts}');
    context.subscriptions.push(this, this.output, this.change, sliccWatcher, cppWatcher, buildWatcher,
      vscode.workspace.onDidOpenTextDocument(doc => this.open(doc)),
      vscode.workspace.onDidChangeTextDocument(event => this.update(event.document)),
      vscode.workspace.onDidCloseTextDocument(doc => {
        this.documents.delete(doc.uri.toString());
        if (isSliccDocument(doc)) void this.reload(doc.uri);
        else if (/\.(?:h|hh|hpp|hxx|c|cc|cpp|cxx)$|\/(?:Kconfig|SConscript|SConsopts)$/.test(doc.uri.path)) this.externalChanged();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.ready = this.reindex(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('slicc.index')) this.ready = this.reindex();
        else if (event.affectsConfiguration('slicc')) this.change.fire();
      }),
      sliccWatcher.onDidCreate(uri => this.reload(uri)), sliccWatcher.onDidChange(uri => this.reload(uri)),
      sliccWatcher.onDidDelete(uri => { this.index.delete(uri.toString()); this.external.protocols.invalidate(); this.change.fire(); }),
      ...[cppWatcher, buildWatcher].flatMap(watcher => [watcher.onDidCreate(() => this.externalChanged()), watcher.onDidChange(() => this.externalChanged()), watcher.onDidDelete(() => this.externalChanged())])
    );
    for (const doc of vscode.workspace.textDocuments) this.open(doc, false);
    this.ready = this.reindex();
  }
  dispose() {
    this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    for (const watcher of [...this.includeWatchers, ...this.dependencyWatchers.values()]) watcher.dispose();
    this.includeWatchers = []; this.dependencyWatchers.clear();
  }
  log(error) { this.output.appendLine(String(error?.stack ?? error)); }
  externalChanged() { this.external.invalidate(); this.debugFlags.invalidate(); this.debounce('external', () => this.change.fire(), 250); }
  dependencyChanged(uri) {
    if (/\.(sm|slicc)$/i.test(uri.path)) { this.external.protocols.invalidate(); void this.reload(uri).catch(e => this.log(e)); }
    else this.externalChanged();
  }
  watchDependencies(dependencies) {
    if (this.disposed) return;
    for (const uri of dependencies) {
      const dir = directory(uri);
      if (this.dependencyWatchers.has(dir) || (vscode.workspace.workspaceFolders ?? []).some(root => isWithin(uri, root.uri.toString()))) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(dir), '*'));
      watcher.onDidCreate(uri => this.dependencyChanged(uri)); watcher.onDidChange(uri => this.dependencyChanged(uri)); watcher.onDidDelete(uri => this.dependencyChanged(uri));
      this.dependencyWatchers.set(dir, watcher);
    }
  }
  debounce(key, fn, delay = 150) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); if (!this.disposed) fn(); }, delay));
  }
  async read(uri) {
    const doc = vscode.workspace.textDocuments.find(x => x.uri.toString() === uri);
    if (doc) return doc.getText();
    try { return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))); } catch { return undefined; }
  }
  open(doc, notify = true) {
    if (!isSliccDocument(doc)) return;
    this.documents.set(doc.uri.toString(), doc);
    this.index.set(doc.uri.toString(), doc.getText());
    this.external.protocols.invalidate();
    if (notify) this.debounce('open', () => { void Promise.all([this.loadIncludes(), this.loadGlobals(doc.uri.toString())]).then(() => this.change.fire()).catch(e => this.log(e)); });
  }
  update(doc) {
    if (isSliccDocument(doc)) { this.open(doc, false); this.debounce('edit', () => { void this.loadIncludes().then(() => this.change.fire()).catch(e => this.log(e)); }); }
    else if (/\.(?:h|hh|hpp|hxx|c|cc|cpp|cxx)$|\/(?:Kconfig|SConscript|SConsopts)$/.test(doc.uri.path)) this.externalChanged();
  }
  async reload(uri) {
    this.globalLoads.clear();
    this.external.protocols.invalidate();
    const key = uri.toString();
    if (this.documents.has(key)) return;
    const text = await this.read(key);
    if (text !== undefined) this.index.set(key, text); else this.index.delete(key);
    await this.loadIncludes(); this.change.fire();
  }
  async loadIncludes() {
    const visited = new Set(), pending = [...this.index.sources.values()];
    while (pending.length && !this.disposed) {
      const source = pending.shift(); if (visited.has(source.uri)) continue; visited.add(source.uri);
      for (const inc of source.includes) {
        let target = this.index.includeTarget(source, inc);
        if (!target) for (const uri of [relativeUri(source.uri, inc.path), ...this.index.includePaths.map(dir => relativeUri(dir, inc.path))]) {
          if (!uri) continue;
          const text = await this.read(uri);
          if (text !== undefined) { target = this.index.set(uri, text); break; }
        }
        if (target) pending.push(target);
      }
    }
  }
  loadGlobals(uri) {
    const start = directory(uri);
    if (!this.globalLoads.has(start)) this.globalLoads.set(start, (async () => {
      let dir = start;
      while (dir && !this.disposed) {
        const candidate = relativeUri(dir, 'RubySlicc_interfaces.slicc');
        if (this.index.sources.has(candidate)) return;
        const text = await this.read(candidate);
        if (text !== undefined) { this.index.set(candidate, text); await this.loadIncludes(); return; }
        const parent = relativeUri(dir, '../'); if (parent === dir) break; dir = parent;
      }
    })());
    return this.globalLoads.get(start);
  }
  async reindex() {
    const epoch = Symbol('index'); this.epoch = epoch;
    this.external.invalidate();
    this.debugFlags.invalidate();
    this.globalLoads.clear();
    for (const watcher of this.includeWatchers) watcher.dispose(); this.includeWatchers = [];
    for (const watcher of this.dependencyWatchers.values()) watcher.dispose(); this.dependencyWatchers.clear();
    const config = vscode.workspace.getConfiguration('slicc'), exclude = config.get('index.exclude');
    const includePaths = [];
    for (const path of config.get('index.includePaths', [])) {
      if (/^[a-z][a-z+.-]*:\/\//i.test(path)) includePaths.push(path.endsWith('/') ? path : path + '/');
      else if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(path)) includePaths.push(vscode.Uri.file(path).toString().replace(/\/?$/, '/'));
      else for (const root of vscode.workspace.workspaceFolders ?? []) includePaths.push(vscode.Uri.joinPath(root.uri, path, '/').toString().replace(/\/?$/, '/'));
    }
    this.index.includePaths = includePaths; this.index.invalidate();
    for (const path of includePaths) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(path), '**/*.{sm,slicc}'));
      watcher.onDidCreate(uri => { void this.reload(uri).catch(e => this.log(e)); }); watcher.onDidChange(uri => { void this.reload(uri).catch(e => this.log(e)); });
      watcher.onDidDelete(uri => { this.index.delete(uri.toString()); this.change.fire(); });
      this.includeWatchers.push(watcher);
    }
    try {
      const found = await vscode.workspace.findFiles('**/*.{sm,slicc}', exclude);
      for (const path of includePaths) found.push(...await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.parse(path), '**/*.{sm,slicc}'), exclude));
      const unique = [...new Map(found.map(uri => [uri.toString(), uri])).values()];
      const keep = new Set([...unique.map(uri => uri.toString()), ...this.documents.keys()]);
      for (const uri of this.index.sources.keys()) if (!keep.has(uri)) this.index.delete(uri);
      for (let i = 0; i < unique.length; i += 12) {
        const batch = await Promise.all(unique.slice(i, i + 12).map(async uri => [uri.toString(), await this.read(uri.toString())]));
        if (this.epoch !== epoch || this.disposed) return;
        for (const [uri, text] of batch) if (text !== undefined) this.index.set(uri, this.documents.get(uri)?.getText() ?? text);
      }
      await this.loadIncludes();
      // Interfaces are implicit compiler inputs. Load them for files opened without a folder too.
      for (const doc of this.documents.values()) await this.loadGlobals(doc.uri.toString());
      this.output.appendLine(`Indexed ${this.index.sources.size} SLICC files.`);
    } catch (error) { this.log(error); }
    if (this.epoch === epoch && !this.disposed) this.change.fire();
  }
  async source(document) {
    await this.ready;
    const source = this.index.set(document.uri.toString(), document.getText());
    await this.loadIncludes(); await this.loadGlobals(source.uri);
    return source;
  }
}

module.exports = { Workspace };

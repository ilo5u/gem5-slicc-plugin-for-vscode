'use strict';

const { lex, unquote } = require('./lexer');
const { pythonText } = require('./script-text');
const { relativeUri, directory, isWithin } = require('./index');

function parseFlags(uri, text) {
  const { tokens: t, issues } = lex(pythonText(text)), flags = [];
  let complete = issues.length === 0;
  for (let i = 0; i < t.length; i++) {
    if (!['DebugFlag', 'CompoundFlag'].includes(t[i].text) || t[i].kind === 'string' || t[i + 1]?.text !== '(') continue;
    const token = t[i + 2], name = unquote(token?.text);
    if (token?.kind !== 'string' || ![',', ')'].includes(t[i + 3]?.text) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? '')) { complete = false; continue; }
    flags.push({ name, uri, start: token.start + 1, end: token.end - 1 });
  }
  return { flags, complete };
}

class DebugFlags {
  constructor(external) { this.external = external; this.host = external.host; this.invalidate(); }
  invalidate() { this.cache = new Map(); this.roots = new Map(); }
  async scope(uri) {
    const projects = this.host.projectRoots?.() ?? [];
    if (projects.some(root => isWithin(uri, root))) return { directories: projects, known: true };
    for (let dir = directory(uri); dir; ) {
      if (await this.host.exists(relativeUri(dir, 'SConstruct'))) return { directories: [dir], known: true };
      const parent = relativeUri(dir, '../'); if (parent === dir) break; dir = parent;
    }
    const ruby = await this.external.rootFor(uri);
    return { directories: ruby ? [this.external.sourceRoot(ruby)] : [], known: false };
  }
  async snapshot(uri) {
    const dir = directory(uri);
    if (!this.roots.has(dir)) this.roots.set(dir, this.scope(uri));
    const scope = await this.roots.get(dir), roots = scope.directories;
    if (!roots.length) return { flags: [], complete: false };
    const key = scope.known + ':' + [...roots].sort().join('\n');
    if (!this.cache.has(key)) this.cache.set(key, this.build(roots, scope.known));
    return this.cache.get(key);
  }
  async build(roots, known) {
    const flags = new Map(), scripts = new Set(), visited = new Set(), dependencies = new Set();
    let complete = known;
    const collect = async dir => {
      if (visited.has(dir)) return; visited.add(dir); dependencies.add(dir);
      const entries = await this.host.list(dir);
      if (!entries) { complete = false; return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.directory && !entry.symlink && !entry.name.startsWith('.') && !['build', 'node_modules', '__pycache__', 'dist'].includes(entry.name)) await collect(relativeUri(dir, entry.name + '/'));
        else if (['SConscript', 'SConsopts'].includes(entry.name)) scripts.add(relativeUri(dir, entry.name));
      }
    };
    for (const root of roots) await collect(root);
    if (!scripts.size) complete = false;
    for (const script of [...scripts].sort()) {
      dependencies.add(script);
      const text = await this.host.read(script); if (text === undefined) { complete = false; continue; }
      const parsed = parseFlags(script, text); complete &&= parsed.complete;
      for (const flag of parsed.flags) if (!flags.has(flag.name)) flags.set(flag.name, flag);
    }
    this.host.watch?.(dependencies);
    return { flags: [...flags.values()], complete };
  }
}

module.exports = { DebugFlags, parseFlags };

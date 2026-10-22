'use strict';

const { lex, unquote } = require('./lexer');
const { relativeUri, directory, isWithin } = require('./index');
const { parseCpp, externalNames, externalTypeName } = require('./cpp');
const { ProtocolNamespaces } = require('./protocols');
const { pythonText } = require('./script-text');
const cpp = uri => /\.(?:h|hh|hpp|hxx|c|cc|cpp|cxx)$/i.test(uri);

class ExternalTypes {
  // The host uses workspace.fs, so this works in remote and virtual workspaces too.
  constructor(host, index) { this.host = host; this.index = index; this.protocols = new ProtocolNamespaces(this); this.invalidate(); }
  invalidate() { this.roots = new Map(); this.snapshots = new Map(); this.protocols.invalidate(); }
  async isRoot(dir) { return await this.host.exists(relativeUri(dir, 'Kconfig')) && await this.host.exists(relativeUri(dir, 'SConscript')) && await this.host.exists(relativeUri(dir, 'protocol/')); }
  async kconfigs(root) {
    const seen = new Set(), pending = [relativeUri(root, 'Kconfig')];
    while (pending.length) {
      const uri = pending.shift(); if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      const text = await this.host.read(uri); if (text === undefined) continue;
      for (const match of text.matchAll(/^\s*(rsource|orsource|source|osource)\s+["']([^"']+)["']/gm)) {
        const base = match[1].endsWith('rsource') ? directory(uri) : this.sourceRoot(root);
        const target = relativeUri(base, match[2]); if (await this.host.exists(target)) pending.push(target);
      }
    }
    return seen;
  }
  sourceRoot(root) {
    const match = /^(.*\/)src\/mem\/ruby\/$/.exec(root);
    return match ? match[1] : root;
  }
  rootFor(uri) {
    const dir = directory(uri);
    if (!this.roots.has(dir)) this.roots.set(dir, this.findRoot(dir));
    return this.roots.get(dir);
  }
  async findRoot(dir) {
    const ancestors = [];
    for (let d = dir; d; ) {
      ancestors.push(d);
      if (await this.isRoot(d)) return d;
      const parent = relativeUri(d, '../'); if (parent === d) break; d = parent;
    }
    for (const ancestor of ancestors) for (const path of ['src/mem/ruby/', 'mem/ruby/', 'ruby/']) {
      const candidate = relativeUri(ancestor, path); if (!await this.isRoot(candidate)) continue;
      for (const config of await this.kconfigs(candidate)) if (isWithin(dir, directory(config))) return candidate;
    }
    return undefined;
  }
  async inspect(sym) {
    let names = externalNames(sym);
    if (names === undefined) return undefined;
    if (!names.length) return { status: 'exempt', locations: [], names };
    const root = await this.rootFor(sym.uri);
    if (!root) return { status: 'unavailable', locations: [], names };
    if (!this.snapshots.has(root)) this.snapshots.set(root, this.build(root));
    const snapshot = await this.snapshots.get(root);
    if (!snapshot.available) return { status: 'unavailable', locations: [], names };
    const ownership = await this.protocols.ownership(root, sym);
    names = externalNames(sym, ownership);
    for (const name of names) {
      const locations = snapshot.definitions.get(name);
      if (locations?.length) return { status: 'resolved', locations, names };
    }
    const unqualified = !externalTypeName(sym).includes('::');
    if (ownership.machine && !ownership.protocol && unqualified) return { status: 'unavailable', locations: [], names, reason: `Cannot determine a unique Kconfig protocol namespace for '${sym.name}'; no shared gem5::ruby definition was found` };
    return { status: 'missing', locations: [], names };
  }
  async build(root) {
    const definitions = new Map(), scripts = new Set(), visited = new Set(), seeds = new Set(), generated = new Map(), dependencies = new Set();
    let available = true;
    const read = async uri => { dependencies.add(uri); return this.host.read(uri); };
    const collect = async dir => {
      if (visited.has(dir)) return; visited.add(dir);
      const entries = await this.host.list(dir);
      if (!entries) { available = false; return; }
      for (const entry of entries) {
        if (entry.directory && !entry.symlink && !entry.name.startsWith('.') && !['build', 'ext', 'node_modules', 'dist'].includes(entry.name)) await collect(relativeUri(dir, entry.name + '/'));
        else if (['SConscript', 'SConsopts'].includes(entry.name)) scripts.add(relativeUri(dir, entry.name));
      }
    };
    await collect(root);
    for (const config of await this.kconfigs(root)) { dependencies.add(config); await collect(directory(config)); }
    const resolve = async (from, path) => {
      const candidates = [relativeUri(from, path)];
      if (path.startsWith('mem/ruby/')) candidates.push(relativeUri(root, path.slice('mem/ruby/'.length)));
      if (path.startsWith('mem/ruby/protocol/')) candidates.push(generated.get(path.slice(path.lastIndexOf('/') + 1)));
      candidates.push(relativeUri(root, path));
      const m = /^(.*\/)src\/mem\/ruby\/$/.exec(root); if (m) candidates.push(relativeUri(m[1] + 'src/', path));
      for (const uri of candidates) if (uri && await this.host.exists(uri)) return uri;
      return undefined;
    };
    const add = async (from, path, forward = false) => {
      const uri = await resolve(from, path);
      if (!uri || !cpp(uri)) return;
      seeds.add(uri); if (forward) generated.set(path.slice(path.lastIndexOf('/') + 1), uri);
    };
    for (const script of scripts) {
      const text = await read(script); if (text === undefined) { available = false; continue; }
      const t = lex(pythonText(text)).tokens;
      for (let i = 0; i < t.length; i++) {
        if (['Source', 'MakeInclude'].includes(t[i].text) && t[i + 1]?.text === '(' && t[i + 2]?.kind === 'string' && [')', ','].includes(t[i + 3]?.text)) await add(directory(script), unquote(t[i + 2].text), t[i].text === 'MakeInclude');
        if (unquote(t[i].text) === 'SLICC_INCLUDES') {
          let j = i + 1;
          if (t[i].kind === 'string') { if (t[i - 1]?.text !== '[' || t[j]?.text !== ']') continue; j++; }
          if (['=', '+='].includes(t[j]?.text)) j++;
          else if (t[j]?.text === '+' && t[j + 1]?.text === '=') j += 2;
          else continue;
          const paths = [];
          if (t[j]?.kind === 'string') paths.push(unquote(t[j].text));
          else if (['[', '('].includes(t[j]?.text)) {
            let depth = 1; j++;
            while (j < t.length && depth) {
              if (['[', '('].includes(t[j].text)) depth++;
              else if ([']', ')'].includes(t[j].text)) depth--;
              else if (t[j].kind === 'string') paths.push(unquote(t[j].text));
              else if (t[j].text !== ',') { paths.length = 0; break; }
              j++;
            }
          }
          for (const path of paths) await add(directory(script), path);
        }
      }
    }
    const standard = relativeUri(root, 'slicc_interface/RubySlicc_includes.hh'); if (await this.host.exists(standard)) seeds.add(standard);
    const pending = [...seeds], files = new Set();
    while (pending.length) {
      const uri = pending.shift(); if (files.has(uri)) continue; files.add(uri);
      const text = await read(uri); if (text === undefined) { available = false; continue; }
      for (const definition of parseCpp(uri, text)) {
        if (!definitions.has(definition.qualifiedName)) definitions.set(definition.qualifiedName, []);
        definitions.get(definition.qualifiedName).push(definition);
      }
      // Mask block / line comments without changing line boundaries before includes.
      const clean = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, match => match.replace(/[^\n\r]/g, ' '));
      for (const match of clean.matchAll(/^\s*#\s*include\s*["<]([^">]+)[">]/gm)) {
        const target = await resolve(directory(uri), match[1]); if (target && cpp(target)) pending.push(target);
      }
    }
    this.host.watch?.(dependencies);
    return { definitions, dependencies, available };
  }
}

module.exports = { ExternalTypes, pythonText };

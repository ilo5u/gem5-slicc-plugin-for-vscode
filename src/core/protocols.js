'use strict';

const { lex, unquote } = require('./lexer');
const { parse, ownerOf } = require('./parser');
const { relativeUri, directory, machineKinds } = require('./index');
const { pythonText } = require('./script-text');
const normalize = name => name.trim().replace(/\s+/g, '_');

// Protocol ownership changes on SLICC edits independently of the C++ graph.
// Keep file parsing in this workspace-owned map, separate from graph snapshots.
class ProtocolNamespaces {
  constructor(external) { this.external = external; this.host = external.host; this.files = new Map(); this.invalidate(); }
  invalidate() { this.snapshots = new Map(); }
  async ownership(root, symbol) {
    if (!this.snapshots.has(root)) this.snapshots.set(root, this.build(root));
    const snapshot = await this.snapshots.get(root), names = snapshot.byFile.get(symbol.uri);
    return {
      protocol: names?.size === 1 ? [...names][0] || undefined : undefined,
      machine: !!ownerOf(symbol.scope, machineKinds) || snapshot.machineFiles.has(symbol.uri)
    };
  }
  async build(root) {
    const aliases = new Map(), protocolFiles = new Set(), sources = new Map(), byFile = new Map(), machineFiles = new Set(), dependencies = new Set(), visited = new Set();
    const alias = (name, protocol) => { if (!aliases.has(name)) aliases.set(name, new Set()); aliases.get(name).add(protocol); };
    const read = async uri => { dependencies.add(uri); return this.host.read(uri); };
    const source = async uri => {
      if (!uri) return undefined;
      if (sources.has(uri)) return sources.get(uri);
      const text = await read(uri); if (text === undefined) return undefined;
      const indexed = this.external.index?.sources.get(uri), previous = this.files.get(uri);
      const parsed = indexed?.text === text ? indexed : previous?.text === text ? previous : parse(uri, text);
      this.files.set(uri, parsed); sources.set(uri, parsed); return parsed;
    };
    const collect = async dir => {
      if (visited.has(dir)) return; visited.add(dir); dependencies.add(dir);
      for (const entry of await this.host.list(dir) ?? []) {
        if (entry.directory && !entry.symlink && !entry.name.startsWith('.') && !['build', 'ext', 'node_modules', 'dist'].includes(entry.name)) await collect(relativeUri(dir, entry.name + '/'));
        else if (!entry.directory && /\.slicc$/i.test(entry.name)) protocolFiles.add(relativeUri(dir, entry.name));
      }
    };
    await collect(root);
    for (const config of await this.external.kconfigs(root)) {
      const text = await read(config); if (text === undefined) continue;
      await collect(directory(config));
      const t = lex(pythonText(text)).tokens;
      let current;
      for (let i = 0; i < t.length; i++) {
        if (t[i].kind === 'string') continue;
        if (['config', 'menuconfig'].includes(t[i].text)) {
          current = t[i + 1]?.kind !== 'string' && /^RUBY_PROTOCOL_.+/.test(t[i + 1]?.text ?? '') ? t[i + 1].text.slice('RUBY_PROTOCOL_'.length) : undefined;
          if (current) alias(current, current);
        } else if (current && t[i].text === 'bool' && t[i + 1]?.kind === 'string') alias(normalize(unquote(t[i + 1].text)), current);
      }
    }
    const includes = file => file.includes.map(inc => relativeUri(file.uri, inc.path));
    for (const uri of protocolFiles) {
      const file = await source(uri); if (!file?.protocols.length) continue;
      const names = new Set(file.protocols.flatMap(name => [...(aliases.get(normalize(name)) ?? [''])]));
      const pending = [file], expanded = new Set();
      while (pending.length) {
        const next = pending.shift(); if (expanded.has(next.uri)) continue; expanded.add(next.uri);
        if (!byFile.has(next.uri)) byFile.set(next.uri, new Set());
        for (const name of names) byFile.get(next.uri).add(name);
        for (const include of includes(next)) { const target = await source(include); if (target) pending.push(target); }
      }
    }
    for (const file of sources.values()) {
      const pending = file.includes.filter(inc => ownerOf(inc.scope, machineKinds)).map(inc => relativeUri(file.uri, inc.path));
      while (pending.length) {
        const uri = pending.shift(); if (machineFiles.has(uri)) continue;
        machineFiles.add(uri);
        const target = await source(uri); if (target) pending.push(...includes(target));
      }
    }
    this.host.watch?.(dependencies);
    return { byFile, machineFiles, dependencies };
  }
}

module.exports = { ProtocolNamespaces };

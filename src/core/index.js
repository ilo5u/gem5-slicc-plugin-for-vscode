'use strict';

const { parse, ownerOf, typeKinds } = require('./parser');
const machineKinds = new Set(['machine']);
const typeOwners = new Set(['structure', 'external_type', 'enumeration', 'state_declaration']);

function relativeUri(from, path) {
  try { return new URL(path.replace(/\\/g, '/'), from).toString(); } catch { return undefined; }
}
function directory(uri) { try { return new URL('.', uri).toString(); } catch { return undefined; } }
function isWithin(uri, dir) { return uri.startsWith(dir.endsWith('/') ? dir : dir + '/'); }

class WorkspaceIndex {
  constructor() { this.sources = new Map(); this.revision = 0; this.includePaths = []; }
  set(uri, text) {
    const old = this.sources.get(uri);
    if (old?.text === text) return old;
    const source = parse(uri, text); this.sources.set(uri, source); this.invalidate(); return source;
  }
  delete(uri) { if (this.sources.delete(uri)) this.invalidate(); }
  invalidate() { this.revision++; this.graphCache = undefined; this.visibilityCache = new Map(); this.expansionCache = new Map(); this.transitionCache = undefined; }
  includeTarget(source, include) {
    const candidates = [relativeUri(source.uri, include.path), ...this.includePaths.map(dir => relativeUri(dir, include.path))];
    return candidates.map(uri => this.sources.get(uri)).find(Boolean);
  }
  closure(source) {
    const out = new Set(), pending = [source];
    while (pending.length) {
      const next = pending.shift(); if (!next || out.has(next)) continue;
      out.add(next);
      for (const inc of next.includes) pending.push(this.includeTarget(next, inc));
    }
    return out;
  }
  machineClosure(source, owner) {
    const files = new Set([source]);
    for (const include of source.includes) if (ownerOf(include.scope, machineKinds) === owner) {
      const target = this.includeTarget(source, include);
      if (target) for (const file of this.closure(target)) files.add(file);
    }
    return files;
  }
  graph() {
    if (this.graphCache) return this.graphCache;
    const groups = [], machines = [], globals = [];
    const sources = [...this.sources.values()].sort((a, b) => a.uri.localeCompare(b.uri));
    for (const source of sources) {
      if (/\/RubySlicc_interfaces\.slicc$/i.test(source.uri)) globals.push({ root: source, files: this.closure(source) });
      else if (/\.slicc$/i.test(source.uri)) groups.push({ root: source, files: this.closure(source) });
      for (const sym of source.symbols) if (sym.kind === 'machine') machines.push({ root: source, symbol: sym, files: this.machineClosure(source, sym) });
    }
    return this.graphCache = { groups, machines, globals };
  }
  machineContexts(source, at = 0) {
    const owner = ownerOf(source.scopeAt(at), machineKinds), graph = this.graph();
    return graph.machines.filter(x => owner ? x.symbol === owner : x.root !== source && x.files.has(source));
  }
  visibility(source, at) {
    const g = this.graph(), explicit = ownerOf(source.scopeAt(at), machineKinds);
    const machine = this.machineContexts(source, at)[0];
    const group = g.groups.find(x => x.files.has(source));
    const key = `${source.uri}#${explicit?.id ?? machine?.symbol.id ?? ''}`;
    if (this.visibilityCache.has(key)) return this.visibilityCache.get(key);
    const machineFiles = machine?.files ?? this.closure(source);
    const protocolFiles = group?.files ?? this.closure(source);
    // Pick the nearest Ruby interface root. Separate gem5 checkouts never share globals.
    const roots = g.globals.filter(x => isWithin(source.uri, directory(x.root.uri))).sort((a, b) => b.root.uri.length - a.root.uri.length);
    const global = roots[0];
    const collect = (files, allowMachine) => {
      const out = [];
      for (const file of files) for (const sym of file.symbols) {
        if (!['file', 'machine'].includes(sym.scope.kind)) continue;
        const owner = ownerOf(sym.scope, machineKinds);
        if (owner && (!allowMachine || owner !== (explicit ?? machine?.symbol))) continue;
        out.push(sym);
      }
      return out;
    };
    const tiers = [collect(machineFiles, true), collect(protocolFiles, false), collect(global?.files ?? [], false)];
    const byName = tiers.map(tier => {
      const map = new Map();
      for (const sym of tier) { if (!map.has(sym.name)) map.set(sym.name, []); map.get(sym.name).push(sym); }
      return map;
    });
    const result = { tiers, byName, machine, group, files: new Set([...machineFiles, ...protocolFiles, ...(global?.files ?? [])]) };
    this.visibilityCache.set(key, result); return result;
  }
  lookup(source, at, name, predicate = () => true) {
    for (const tier of this.visibility(source, at).byName) {
      const found = (tier.get(name) ?? []).filter(predicate);
      if (found.length) return found;
    }
    return [];
  }
  visible(source, at) {
    const visibility = this.visibility(source, at);
    if (visibility.visible) return visibility.visible;
    const result = [], seen = new Set();
    for (const tier of visibility.tiers) {
      const names = new Set();
      for (const sym of tier) if (!seen.has(sym.name)) { result.push(sym); names.add(sym.name); }
      for (const name of names) seen.add(name);
    }
    visibility.visible = result;
    return result;
  }
  types(source, at, name) { return this.lookup(source, at, name, s => typeKinds.has(s.kind)); }
  expansion(source, owner) {
    const key = owner?.id ?? source.uri;
    if (this.expansionCache.has(key)) return this.expansionCache.get(key);
    const result = { actions: new Map(), transitions: [], complete: true }, visited = new Set(), active = new Set();
    const collect = (file, scope) => {
      const events = [...scope.symbols, ...file.includes.filter(inc => inc.scope === scope)].sort((a, b) => a.start - b.start);
      for (const entry of events) {
        if (entry.path !== undefined) { const target = this.includeTarget(file, entry); if (target) expand(target); else result.complete = false; }
        else if (entry.kind === 'machine' && entry === owner) { if (entry.bodyScope) collect(file, entry.bodyScope); else result.complete = false; }
        else if (entry.kind === 'action') { if (!result.actions.has(entry.name)) result.actions.set(entry.name, []); result.actions.get(entry.name).push(entry); }
        else if (entry.kind === 'transition') result.transitions.push({ source: file, symbol: entry });
      }
    };
    const expand = file => {
      if (active.has(file)) { result.complete = false; return; }
      if (visited.has(file)) return;
      visited.add(file); active.add(file);
      if (file.issues.length) result.complete = false;
      collect(file, file.root); active.delete(file);
    };
    expand(source); this.expansionCache.set(key, result); return result;
  }
  contextComplete(source, at) {
    const owners = this.machineContexts(source, at);
    if (owners.length > 1) return false;
    if (owners.length === 1) return this.expansion(owners[0].root, owners[0].symbol).complete;
    return this.expansion(source).complete;
  }
  primaryCacheEntry(source, at) {
    const scope = this.visibility(source, at);
    if (!this.contextComplete(source, at)) return undefined;
    if (scope.cacheEntryComputed) return scope.cacheEntry;
    scope.cacheEntryComputed = true;
    for (const tier of scope.tiers) {
      const candidates = tier.filter(s => s.kind === 'structure' && s.attributes.interface === 'AbstractCacheEntry' && s.attributes.main?.toLowerCase() !== 'false');
      if (candidates.length) { scope.cacheEntry = candidates.length === 1 ? candidates[0] : undefined; break; }
    }
    return scope.cacheEntry;
  }
  sameSymbol(a, b) {
    if (!a || !b) return false;
    if (a.id === b.id) return true;
    if (a.kind !== 'function' || b.kind !== 'function' || a.name !== b.name || a.params.length !== b.params.length) return false;
    if (a.params.some((p, i) => p.type.replace(/\s/g, '') !== b.params[i].type.replace(/\s/g, ''))) return false;
    const ao = ownerOf(a.scope, typeOwners), bo = ownerOf(b.scope, typeOwners);
    if (ao || bo) return ao?.id === bo?.id;
    const am = ownerOf(a.scope, machineKinds), bm = ownerOf(b.scope, machineKinds);
    if (am && bm) return am.id === bm.id;
    const as = this.sources.get(a.uri), bs = this.sources.get(b.uri);
    if (am) return this.closure(as).has(bs);
    if (bm) return this.closure(bs).has(as);
    if (a.uri === b.uri) return true;
    const graph = this.graph();
    return [...graph.machines, ...graph.groups, ...graph.globals].some(g => g.files.has(as) && g.files.has(bs));
  }
}

module.exports = { WorkspaceIndex, relativeUri, directory, isWithin, typeOwners, machineKinds };

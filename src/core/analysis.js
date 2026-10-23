'use strict';

const { baseType, typeKey, primitives, constants, builtinNames, voidBuiltins, decodeDescription } = require('./lexer');
const { callArguments } = require('./calls');
const { ownerOf, typeKinds } = require('./parser');
const { typeOwners, machineKinds } = require('./index');
const implicitTypes = Object.assign(Object.create(null), { tbe: 'TBE', cache_entry: 'Entry', address: 'Addr' });
const implicitOwners = new Set(['action']);

class Analysis {
  constructor(index, source, cancelled = () => false) {
    this.index = index; this.source = source; this.t = source.tokens; this.cancelled = cancelled;
    this.resolutions = new Map(); this.inferring = new Set(); this.expressions = new Map(); this.memberCache = new Map(); this.callCache = new Map();
  }
  get(i) { return this.t[i]?.text; }
  explicitVariables(at) {
    const out = [], seen = new Set();
    for (let s = this.source.scopeAt(at); s; s = s.parent) {
      const vars = s.symbols.filter(x => ['variable', 'parameter', 'field'].includes(x.kind) && (x.kind !== 'variable' || x.nameEnd <= at));
      for (const sym of vars.reverse()) if (!seen.has(sym.name)) { seen.add(sym.name); out.push(sym); }
    }
    for (const sym of this.index.visible(this.source, at)) if (sym.kind === 'field' && !seen.has(sym.name)) { seen.add(sym.name); out.push(sym); }
    return out;
  }
  implicit(name, at) {
    if (this.explicitVariables(at).some(x => x.name === name)) return undefined;
    for (let s = this.source.scopeAt(at); s; s = s.parent) if (s.bindings.has(name)) return s.bindings.get(name);
    if (implicitTypes[name]) {
      const owner = ownerOf(this.source.scopeAt(at), implicitOwners);
      if (owner) {
        const target = name === 'cache_entry' ? this.index.primaryCacheEntry(this.source, at) : undefined;
        const type = name === 'cache_entry' ? target?.name : implicitTypes[name];
        return { id: `${owner.id}:implicit:${name}`, name, type, typeTarget: target, uri: this.source.uri, nameStart: owner.nameStart, nameEnd: owner.nameEnd, kind: 'variable', implicit: true, scope: owner.bodyScope };
      }
    }
    return undefined;
  }
  visibleVariables(at) {
    const vars = this.explicitVariables(at);
    for (const sym of this.index.visible(this.source, at)) if (['in_port', 'out_port'].includes(sym.kind) && !vars.some(v => v.name === sym.name) && this.port(sym.name, at).declaration === sym) vars.push(sym);
    for (const name of ['in_msg', 'out_msg', ...Object.keys(implicitTypes)]) { const sym = this.implicit(name, at); if (sym) vars.push(sym); }
    return vars;
  }
  port(name, at) {
    const candidates = this.index.lookup(this.source, at, name, s => ['in_port', 'out_port'].includes(s.kind));
    return { known: candidates.length > 0, declaration: candidates.length === 1 && this.index.machineContexts(this.source, at).length <= 1 ? candidates[0] : undefined };
  }
  enumDefault(i) {
    const owner = this.source.defaults.get(i);
    if (!owner || this.explicitVariables(this.t[i].start).some(s => s.name === this.get(i))) return undefined;
    if (this.index.machineContexts(this.source, this.t[i].start).length > 1) return { deferred: true };
    let declaration = owner;
    if (!['enumeration', 'state_declaration'].includes(owner.kind)) {
      const types = this.index.types(this.source, owner.nameStart, baseType(owner.type));
      if (types.length > 1) return { deferred: true };
      declaration = types[0];
    }
    if (!declaration || !['enumeration', 'state_declaration'].includes(declaration.kind)) return undefined;
    if (!declaration.hasBody || !declaration.bodyScope?.closed || declaration.bodyScope.recovered) return { deferred: true };
    const members = declaration.bodyScope.symbols;
    let matches = members.filter(s => s.name === this.get(i));
    if (!matches.length) matches = members.filter(s => `${declaration.name}_${s.name}` === this.get(i));
    return { deferred: matches.length > 1, member: matches.length === 1 ? matches[0] : undefined };
  }
  generatedTypeName(declaration, at) {
    const file = this.index.sources.get(declaration.uri), owners = this.index.machineContexts(file, declaration.nameStart);
    if (!owners.length) return declaration.name;
    if (Object.hasOwn(declaration.attributes, 'external') || Object.hasOwn(declaration.attributes, 'primitive')) return declaration.attributes.external_name ?? declaration.name;
    const context = this.index.machineContexts(this.source, at), selected = owners.filter(o => context.some(c => c.symbol.id === o.symbol.id));
    return selected.length === 1 ? `${selected[0].symbol.name}_${declaration.name}` : undefined;
  }
  generated(i) {
    const name = this.get(i), at = this.t[i]?.start;
    if (!name || !/_(?:to_string|to_permission)$/.test(name) || this.get(i + 1) !== '(' || this.source.declarations.has(i) || ['.', ':', '::', 'new'].includes(this.get(i - 1))) return undefined;
    if (this.explicitVariables(at).some(s => s.name === name) || this.port(name, at).known || this.index.machineContexts(this.source, at).length > 1) return undefined;
    if (this.call(i)?.allCandidates.length) return undefined;
    const permission = name.endsWith('_to_permission'), suffix = permission ? '_to_permission' : '_to_string';
    for (const tier of this.index.visibility(this.source, at).tiers) {
      const matches = tier.filter(s => (s.kind === 'state_declaration' || !permission && s.kind === 'enumeration') && this.generatedTypeName(s, at) + suffix === name);
      if (matches.length) return matches.length === 1 && matches[0].bodyScope?.closed && !matches[0].bodyScope.recovered ? matches[0] : undefined;
    }
    return undefined;
  }
  typeDeclaration(type, source = this.source, at = 0) {
    const found = this.index.types(source, at, baseType(type));
    return found.length === 1 ? found[0] : undefined;
  }
  members(type, at, source = this.source) {
    const decl = typeof type === 'string' ? this.typeDeclaration(type, source, at) : type;
    if (!decl) return { symbols: [], complete: false };
    if (this.memberCache.has(decl.id)) return this.memberCache.get(decl.id);
    const walk = (d, visited) => {
      if (!d || visited.has(d.id) || !d.hasBody && d.kind !== 'external_type' || !['structure', 'external_type'].includes(d.kind)) return { symbols: [], complete: false };
      visited.add(d.id);
      const own = (d.bodyScope?.symbols ?? []).filter(x => ['field', 'function'].includes(x.kind));
      let inherited = { symbols: [], complete: true };
      if (d.attributes.interface) {
        const src = this.index.sources.get(d.uri), parents = this.index.types(src, d.nameStart, d.attributes.interface);
        inherited = parents.length === 1 ? walk(parents[0], visited) : { symbols: [], complete: false };
      }
      const key = x => x.kind === 'function' ? `${x.name}(${x.params.map(p => typeKey(p.type)).join(',')})` : x.name;
      const keys = new Set(own.map(key));
      return { symbols: [...own, ...inherited.symbols.filter(x => !keys.has(key(x)))], complete: inherited.complete };
    };
    const result = walk(decl, new Set()); this.memberCache.set(decl.id, result); return result;
  }
  typed(sym, hasCall = false) {
    if (!sym) return { hasCall };
    return { type: sym.type, source: this.index.sources.get(sym.typeTarget?.uri ?? sym.uri) ?? this.source, at: sym.typeTarget?.nameStart ?? sym.nameStart, target: sym, hasCall };
  }
  compatibility(actual, expected) {
    if (!actual?.type || !expected?.type) return undefined;
    const a = baseType(actual.type), e = baseType(expected.type);
    if (primitives.has(a) && primitives.has(e)) return a === e;
    const ad = this.typeDeclaration(a, actual.source ?? this.source, actual.at ?? 0), ed = this.typeDeclaration(e, expected.source ?? this.source, expected.at ?? 0);
    if (!ad || !ed) return undefined;
    if (ad.id === ed.id) return true;
    const visited = new Set(); let current = ad;
    while (current?.attributes.interface) {
      if (visited.has(current.id)) return undefined;
      visited.add(current.id);
      const src = this.index.sources.get(current.uri), parent = this.index.types(src, current.nameStart, current.attributes.interface);
      if (parent.length !== 1) return undefined;
      current = parent[0]; if (current.id === ed.id) return true;
    }
    current = ed; visited.clear();
    while (current?.attributes.interface) {
      if (visited.has(current.id)) return undefined;
      visited.add(current.id);
      const parents = this.index.types(this.index.sources.get(current.uri), current.nameStart, current.attributes.interface);
      if (parents.length !== 1) return undefined;
      current = parents[0];
    }
    return false;
  }
  resolve(i) {
    if (this.cancelled()) return [];
    if (this.resolutions.has(i)) return this.resolutions.get(i);
    this.resolutions.set(i, []); // Stop cycles caused by incomplete call expressions.
    const result = this.resolveRaw(i);
    this.resolutions.set(i, result); return result;
  }
  resolveRaw(i) {
    const token = this.t[i]; if (!token) return [];
    const declaration = this.source.declarations.get(i); if (declaration) return [declaration];
    const name = token.text, at = token.start, role = this.source.roles.get(i);
    if (['attribute', 'resource', 'protocol'].includes(role)) return [];
    if (role === 'type') return this.index.types(this.source, at, name);
    if (this.get(i - 1) === '.') {
      const receiver = this.receiver(i - 1);
      const members = this.members(receiver.type, receiver.at ?? at, receiver.source ?? this.source).symbols.filter(x => x.name === name);
      return this.get(i + 1) === '(' ? this.selectOverloads(members.filter(x => x.kind === 'function'), this.arguments(i + 1)).selected : members.filter(x => x.kind === 'field');
    }
    if (this.get(i - 1) === ':' || this.get(i - 1) === '::') {
      const types = this.index.types(this.source, at, this.scopedOwner(i));
      const members = types.flatMap(x => ['enumeration', 'state_declaration'].includes(x.kind) ? x.bodyScope?.symbols ?? [] : this.members(x, at).symbols).filter(x => x.name === name);
      return this.get(i + 1) === '(' ? this.selectOverloads(members.filter(x => x.kind === 'function'), this.arguments(i + 1)).selected : members;
    }
    if (role === 'state' || role === 'event') {
      return this.index.types(this.source, at, role === 'state' ? 'State' : 'Event').flatMap(x => x.bodyScope?.symbols ?? []).filter(x => x.name === name);
    }
    if (role === 'action') return this.index.lookup(this.source, at, name, s => s.kind === 'action');
    const vars = this.explicitVariables(at).filter(x => x.name === name);
    if (vars.length) return [vars[0]];
    const enumDefault = this.enumDefault(i);
    if (enumDefault) return enumDefault.member ? [enumDefault.member] : [];
    const port = this.port(name, at);
    if (port.known) return port.declaration ? [port.declaration] : [];
    const implicit = this.implicit(name, at); if (implicit) return [implicit];
    if (this.get(i + 1) === '(') {
      const call = this.call(i);
      if (call?.allCandidates.length) return call.selected;
      const generated = this.generated(i); return generated ? [generated] : [];
    }
    const symbols = this.index.lookup(this.source, at, name);
    if (symbols.length) return symbols;
    const enums = this.index.visible(this.source, at).filter(x => ['enumeration', 'state_declaration'].includes(x.kind)).flatMap(x => x.bodyScope?.symbols ?? []).filter(x => x.name === name);
    return enums.length === 1 ? enums : [];
  }
  arguments(open) {
    return callArguments(this.source, open)?.map(([a, b]) => ({ begin: a, end: b, value: this.infer(a, b), start: this.t[a]?.start, finish: this.t[b - 1]?.end }));
  }
  scopedOwner(i) {
    let begin = i - 2;
    while (this.get(begin - 1) === '::' && this.t[begin - 2]?.kind === 'identifier') begin -= 2;
    return this.t.slice(begin, i - 1).map(token => token.text).join('');
  }
  selectOverloads(candidates, args) {
    if (!args) return { candidates, selected: candidates };
    const arity = candidates.filter(x => x.params.length === args.length);
    const scored = arity.map(sym => {
      let score = 0, mismatch = false;
      sym.params.forEach((p, j) => { const compatible = this.compatibility(args[j].value, this.typed(p)); if (compatible === false) mismatch = true; else if (compatible === true) score++; });
      return { sym, score, mismatch };
    });
    const compatible = scored.filter(x => !x.mismatch), best = Math.max(-1, ...compatible.map(x => x.score));
    let selected = compatible.filter(x => x.score === best).map(x => x.sym);
    if (!selected.length) selected = arity;
    // Prefer a definition over its exact prototype, retaining distinct overloads.
    selected = selected.filter(s => s.hasBody || !selected.some(other => other.hasBody && this.index.sameSymbol(s, other)));
    return { candidates: arity.length ? arity : candidates, selected };
  }
  call(i) {
    if (this.callCache.has(i)) return this.callCache.get(i);
    const t = this.t[i];
    if (!t || this.get(i + 1) !== '(' || this.source.declarations.has(i)) return undefined;
    this.callCache.set(i, undefined);
    let candidates = [];
    if (this.get(i - 1) === '.') {
      const receiver = this.receiver(i - 1);
      candidates = this.members(receiver.type, receiver.at ?? t.start, receiver.source ?? this.source).symbols.filter(s => s.name === t.text && s.kind === 'function');
    } else if (['::', ':'].includes(this.get(i - 1))) {
      const types = this.index.types(this.source, t.start, this.scopedOwner(i));
      candidates = types.flatMap(d => this.members(d, t.start).symbols).filter(s => s.name === t.text && s.kind === 'function');
    } else if (!this.explicitVariables(t.start).some(s => s.name === t.text) && !this.port(t.text, t.start).known) {
      const owner = ownerOf(this.source.scopeAt(t.start), typeOwners);
      if (owner) candidates = this.members(owner, t.start).symbols.filter(s => s.name === t.text && s.kind === 'function');
      if (!candidates.length) candidates = this.index.lookup(this.source, t.start, t.text, s => s.kind === 'function');
    }
    const args = this.arguments(i + 1), selected = this.selectOverloads(candidates, args);
    const result = { ...selected, allCandidates: candidates, arguments: args, name: t.text, token: i, end: this.source.pairs.get(i + 1), complete: args !== undefined };
    this.callCache.set(i, result); return result;
  }
  expressionStart(end) {
    if (end < 0) return 0;
    let i = end;
    if ([')', ']'].includes(this.get(i))) {
      const open = this.source.pairs.get(i); if (open === undefined) return i;
      i = open;
      if (open > 0 && (this.t[open - 1]?.kind === 'identifier' || voidBuiltins.has(this.get(open - 1)) || ['static_cast', 'is_valid', 'is_invalid'].includes(this.get(open - 1)))) i--;
    }
    while (i > 1 && ['.', ':', '::'].includes(this.get(i - 1))) i = this.expressionStart(i - 2);
    return i;
  }
  receiver(dot) { return this.infer(this.expressionStart(dot - 1), dot); }
  infer(begin, end) {
    const key = `${begin}:${end}`;
    if (this.expressions.has(key)) return this.expressions.get(key);
    if (this.inferring.has(key) || this.inferring.size > 60 || this.cancelled()) return { hasCall: false };
    this.inferring.add(key);
    const result = this.inferRaw(begin, end);
    this.inferring.delete(key); this.expressions.set(key, result); return result;
  }
  inferRaw(begin, end) {
    const t = this.t, at = t[begin]?.start ?? 0;
    const hasCall = t.slice(begin, end).some((x, j) => (x.kind === 'identifier' || builtinNames.has(x.text)) && this.get(begin + j + 1) === '(');
    const unknown = { hasCall };
    if (begin >= end) return unknown;
    if (this.get(begin) === '(' && this.source.pairs.get(begin) === end - 1) return this.infer(begin + 1, end - 1);
    if (end === begin + 1) {
      const token = t[begin];
      if (token.kind === 'string') return { type: 'string', source: this.source, at, hasCall: false };
      if (token.kind === 'number') return { type: /[.eEfF]/.test(token.text.replace(/^0x[\da-f]+$/i, '0')) ? 'float' : 'int', source: this.source, at, hasCall: false };
      if (['true', 'false'].includes(token.text)) return { type: 'bool', source: this.source, at, hasCall: false };
      if (constants.has(token.text)) return unknown;
      return this.typed(this.resolve(begin).find(x => ['field', 'variable', 'parameter', 'enumMember', 'in_port', 'out_port'].includes(x.kind)));
    }
    if (['-', '+'].includes(this.get(begin)) && end === begin + 2 && t[begin + 1].kind === 'number') return this.infer(begin + 1, end);
    if (this.get(begin) === 'new') {
      const name = this.get(begin + 1); return this.typeDeclaration(name, this.source, at) ? { type: name, source: this.source, at, hasCall } : unknown;
    }
    if (this.get(begin) === 'static_cast' && this.get(begin + 1) === '(' && this.source.pairs.get(begin + 1) === end - 1) {
      const args = this.source.parts(begin + 2, end - 1); return args[0] ? { type: this.get(args[0][0]), source: this.source, at, hasCall } : unknown;
    }
    // A simple field chain, enum constant, or complete free/member/scoped call.
    if (this.get(end - 1) === ')') {
      const open = this.source.pairs.get(end - 1), nameIndex = open - 1;
      if (open !== undefined && nameIndex >= begin && this.expressionStart(end - 1) === begin) {
        if (voidBuiltins.has(this.get(nameIndex)) && !['.', ':', '::'].includes(this.get(nameIndex - 1)) && callArguments(this.source, open)) return { type: 'void', source: this.source, at, hasCall: true };
        if (['is_valid', 'is_invalid'].includes(this.get(nameIndex)) && !['.', ':', '::'].includes(this.get(nameIndex - 1))) return { type: 'bool', source: this.source, at, hasCall: true };
        const call = this.call(nameIndex);
        if (call?.selected.length) {
          const first = this.typed(call.selected[0], true);
          if (call.selected.every(s => this.compatibility(this.typed(s), first) === true)) return first;
        }
      }
      return unknown;
    }
    if (t[end - 1]?.kind === 'identifier' && ['.', ':', '::'].includes(this.get(end - 2)) && this.expressionStart(end - 1) === begin) {
      const targets = this.resolve(end - 1);
      if (targets.length === 1) return { ...this.typed(targets[0], hasCall), hasCall };
    }
    return unknown;
  }
  references(symbol, includeDeclaration = false) {
    const out = [];
    const files = symbol.kind === 'field' && symbol.scope.kind === 'machine'
      ? this.index.graph().machines.find(machine => machine.symbol.id === symbol.scope.owner.id)?.files ?? []
      : this.index.sources.values();
    for (const source of files) {
      if (this.cancelled()) break;
      const analysis = source === this.source ? this : new Analysis(this.index, source, this.cancelled);
      for (const token of source.tokens) {
        if (token.text !== symbol.name && !source.defaults.has(token.index) && !(['enumeration', 'state_declaration'].includes(symbol.kind) && /_(?:to_string|to_permission)$/.test(token.text))) continue;
        if (source.declarations.has(token.index)) {
          if (includeDeclaration && this.index.sameSymbol(source.declarations.get(token.index), symbol)) out.push({ source, token });
          continue;
        }
        if (analysis.resolve(token.index).some(s => this.index.sameSymbol(s, symbol))) out.push({ source, token });
      }
    }
    return out;
  }
  related(symbol) {
    const seen = new Set(), out = [];
    for (const ref of this.references(symbol)) {
      let container = ref.source.statements.filter(s => s.start <= ref.token.start && ref.token.end <= s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      const transition = ownerOf(ref.source.scopeAt(ref.token.start), new Set(['transition'])) ?? ref.source.transitions.find(s => s.start <= ref.token.start && ref.token.end <= s.end);
      if (transition) container = transition;
      container ??= { start: ref.token.start, end: ref.token.end };
      const key = `${ref.source.uri}:${container.start}`;
      if (!seen.has(key)) { seen.add(key); out.push({ ...ref, start: container.start, end: container.end }); }
    }
    return out;
  }
  description(symbol) {
    const direct = symbol.attributes?.desc;
    if (direct?.trim()) return decodeDescription(direct);
    if (symbol.kind !== 'function') return undefined;
    const values = new Set();
    const source = this.index.sources.get(symbol.uri);
    for (const file of this.index.visibility(source, symbol.nameStart).files) for (const other of file.symbols) {
      if (other.attributes?.desc?.trim() && this.index.sameSymbol(symbol, other)) values.add(other.attributes.desc);
    }
    return values.size === 1 ? decodeDescription([...values][0]) : undefined;
  }
}

function signature(sym) { return sym.kind === 'function' ? `${sym.type} ${sym.name}(${sym.params.map(p => `${p.type}${p.name ? ' ' + p.name : ''}`).join(', ')})` : `${sym.kind} ${sym.name}${sym.type ? ': ' + sym.type : ''}`; }
module.exports = { Analysis, signature, implicitTypes };

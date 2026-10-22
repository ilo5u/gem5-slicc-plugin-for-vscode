'use strict';

const { lex, unquote, primitives, attributes } = require('./lexer');
const typeKinds = new Set(['structure', 'external_type', 'enumeration', 'state_declaration']);
const callableKinds = new Set(['function', 'action']);
const declarationStarts = new Set(['machine', 'structure', 'global', 'enumeration', 'state_declaration', 'external_type', 'action', 'transition', 'in_port', 'out_port', 'include', 'protocol']);

function parse(uri, text) {
  const source = { uri, text, ...lex(text), pairs: new Map(), roles: new Map(), declarations: new Map(), defaults: new Map(), symbols: [], includes: [], protocols: [], scopes: [], statements: [], transitions: [] };
  const t = source.tokens;
  const stack = [], matching = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < t.length; i++) {
    const v = t[i].text;
    if (['(', '[', '{'].includes(v)) stack.push(i);
    else if (Object.hasOwn(matching, v)) {
      if (stack.length && t[stack[stack.length - 1]].text === matching[v]) {
        const open = stack.pop(); source.pairs.set(open, i); source.pairs.set(i, open);
      } else source.issues.push({ ...range(i), message: `Unexpected '${v}'`, code: 'syntax' });
    }
  }
  for (const i of stack) source.issues.push({ ...range(i), message: `Unclosed '${t[i].text}'`, code: 'syntax' });
  const fileScope = scope('file', 0, t.length, null);
  source.root = fileScope;

  function value(i) { return t[i]?.text; }
  function isName(i) { return t[i]?.kind === 'identifier' || attributes.includes(value(i)); }
  function range(i) { return { start: t[i]?.start ?? text.length, end: t[i]?.end ?? text.length }; }
  function offset(i) { return t[i]?.start ?? text.length; }
  function close(i, limit) { return Math.min(source.pairs.get(i) ?? limit, limit); }
  function scope(kind, begin, end, parent, owner) {
    const s = { kind, start: offset(begin), end: offset(end), begin, limit: end, parent, owner, symbols: [], bindings: new Map() };
    source.scopes.push(s); return s;
  }
  function mark(begin, end, role) { for (let i = begin; i < end; i++) source.roles.set(i, role); }
  function parts(begin, end, separator = ',') {
    const out = []; let start = begin;
    for (let i = begin; i < end; i++) {
      if (value(i) === separator) { out.push([start, i]); start = i + 1; }
      else if (source.pairs.get(i) > i) i = source.pairs.get(i);
    }
    if (start < end) out.push([start, end]);
    return out;
  }
  source.parts = parts;
  function symbol(kind, nameIndex, begin, end, parent, extra = {}) {
    const n = t[nameIndex];
    const sym = { id: `${uri}#${n?.start ?? offset(begin)}:${kind}`, uri, name: n?.text ?? '', kind, start: offset(begin), end: offset(end), nameStart: n?.start ?? offset(begin), nameEnd: n?.end ?? offset(begin), tokenIndex: nameIndex, scope: parent, children: [], attributes: Object.create(null), params: [], ...extra };
    source.symbols.push(sym); parent.symbols.push(sym);
    if (n) { source.declarations.set(nameIndex, sym); source.roles.set(nameIndex, 'declaration'); }
    for (let p = parent; p; p = p.parent) { if (p.owner) { p.owner.children.push(sym); break; } }
    return sym;
  }
  function readType(i, end) {
    const begin = i;
    if (!(t[i]?.kind === 'identifier' || primitives.has(value(i)))) return null;
    i++;
    while (value(i) === '::' && t[i + 1]) i += 2;
    if (value(i) === '<') {
      let depth = 1, j = i + 1;
      while (j < end && depth) { if (value(j) === '<') depth++; else if (value(j) === '>') depth--; else if (value(j) === '>>') depth -= 2; j++; }
      if (depth === 0) i = j;
    }
    while (['*', '&'].includes(value(i))) i++;
    return { begin, end: i, type: t.slice(begin, i).map(x => x.text).join(' ').replace(/\s*::\s*/g, '::') };
  }
  function attrs(begin, end, target) {
    for (const [a, b] of parts(begin, end)) {
      if (value(a + 1) === '=') {
        source.roles.set(a, 'attribute');
        if (target) target.attributes[value(a)] = unquote(t.slice(a + 2, b).map(x => x.text).join(''));
        if (target && value(a) === 'default' && b === a + 3 && t[a + 2]?.kind === 'identifier') source.defaults.set(a + 2, target);
      } else if (b === a + 1 && t[a]?.kind === 'string' && target && !target.description) target.description = unquote(value(a));
    }
  }
  function statementEnd(i, end) {
    for (; i < end; i++) {
      if (declarationStarts.has(value(i))) return i;
      if (value(i) === ';') return i + 1;
      if (source.pairs.get(i) > i) i = source.pairs.get(i);
      else if (value(i) === '}') return i;
    }
    return end;
  }
  function addStatement(begin, end, parent, decl) {
    if (end > begin) source.statements.push({ begin, limit: end, start: offset(begin), end: offset(end), scope: parent, declaration: decl });
  }
  function body(begin, end, parent, kind, owner, binding) {
    const s = scope(kind, begin + 1, end, parent, owner);
    s.closed = source.pairs.get(begin) === end;
    if (owner) { owner.bodyScope = s; owner.hasBody = true; }
    if (binding) s.bindings.set(binding.name, { ...binding, id: `${uri}#implicit:${begin}:${binding.name}`, scope: s, implicit: true, kind: 'variable', uri, nameStart: binding.start, nameEnd: binding.end });
    const last = parseRange(begin + 1, end, s);
    if (last < end) {
      s.limit = last; s.end = offset(last); s.recovered = true;
      if (!source.issues.length) source.issues.push({ ...range(begin), message: "Unclosed '{'", code: 'syntax' });
    }
    return s;
  }
  function named(i, end, parent) {
    const kind = value(i), open = i + 1;
    if (value(open) !== '(') return i + 1;
    const headerEnd = close(open, end);
    const header = parts(open + 1, headerEnd);
    let nameIndex = open + 1;
    if (kind === 'machine' && value(nameIndex + 1) === ':') { source.roles.set(nameIndex, 'type'); nameIndex += 2; }
    const actualKind = kind === 'global' ? 'structure' : kind;
    const externalName = kind === 'external_type' ? readType(nameIndex, headerEnd) : undefined;
    const sym = symbol(actualKind, nameIndex, i, headerEnd + 1, parent, externalName ? { name: externalName.type, nameEnd: t[externalName.end - 1].end } : {});
    if (externalName) for (let n = nameIndex; n < externalName.end; n++) if (t[n].kind !== 'operator') { source.declarations.set(n, sym); source.roles.set(n, 'declaration'); }
    attrs(externalName?.end ?? open + 2, headerEnd, sym);
    let next = headerEnd + 1;
    if (kind === 'machine' && value(next) === ':') {
      next++;
      const s = scope('machine', next, end, parent, sym);
      sym.bodyScope = s;
      while (next < end && value(next) !== '{') {
        const old = next; next = parseOne(next, end, s, true); if (next <= old) next = old + 1;
      }
      if (value(next) === '{') {
        const last = close(next, end); s.end = offset(last); s.limit = last;
        parseRange(next + 1, last, s); sym.hasBody = true; sym.end = offset(last + 1); next = last + 1;
      }
      return next;
    }
    if (kind === 'in_port' || kind === 'out_port') {
      sym.type = kind === 'in_port' ? 'InPort' : 'OutPort';
      if (header[1]) mark(...header[1], 'type');
    }
    if (value(next) === '{') {
      const last = close(next, end);
      if (actualKind === 'enumeration' || actualKind === 'state_declaration') {
        const s = scope('enum', next + 1, last, parent, sym); sym.bodyScope = s; sym.hasBody = true;
        s.closed = source.pairs.get(next) === last;
        let a = next + 1;
        while (a < last) {
          const b = statementEnd(a, last);
          if (t[a]?.kind === 'identifier') { const m = symbol('enumMember', a, a, b, s, { type: sym.name }); attrs(a + 1, b - (value(b - 1) === ';' ? 1 : 0), m); }
          a = Math.max(a + 1, b);
        }
      } else {
        const parsed = body(next, last, parent, actualKind, sym);
        if (parsed.recovered) { sym.end = parsed.end; return parsed.limit; }
      }
      sym.end = offset(last + 1); next = last + 1;
    }
    if (value(next) === ';') next++;
    return next;
  }
  function transition(i, end, parent) {
    const h = i + 1;
    if (value(h) !== '(') return i + 1;
    const last = close(h, end), args = parts(h + 1, last);
    for (let a = 0; a < args.length; a++) for (let j = args[a][0]; j < args[a][1]; j++) if (t[j].kind === 'identifier') source.roles.set(j, a === 1 ? 'event' : 'state');
    let next = last + 1;
    const label = t.slice(h + 1, last).map(x => x.text).join(' ');
    const names = ([a, b] = []) => {
      if (a === undefined) return undefined;
      if (b === a + 1 && t[a].kind === 'identifier') return [value(a)];
      if (value(a) !== '{' || value(b - 1) !== '}' || b - a < 3) return undefined;
      const out = [];
      let expectName = true;
      for (let n = a + 1; n < b - 1; n++) {
        if (t[n].kind === 'identifier') { out.push(value(n)); expectName = false; }
        else if (!expectName && [',', ';'].includes(value(n))) expectName = true;
        else return undefined;
      }
      return out.length ? [...new Set(out)] : undefined;
    };
    const sym = symbol('transition', i, i, next, parent, { name: label, nameStart: offset(i), nameEnd: t[i].end, headerEnd: t[last]?.end, states: names(args[0]), events: names(args[1]), actionTokens: [], complete: false });
    source.transitions.push(sym);
    const wildcard = args[2]?.[1] === args[2]?.[0] + 1 && value(args[2][0]) === '*';
    const validHeader = !!sym.states?.length && !!sym.events?.length && args.length >= 2 && args.length <= 3 && (args.length !== 3 || wildcard || !!names(args[2])?.length);
    if (!validHeader && source.pairs.has(h)) source.issues.push({ ...range(i), message: 'Invalid transition state/event list or next state', code: 'syntax' });
    if (value(next) === '{') {
      let b = close(next, end);
      if (value(b + 1) === '{') { mark(next + 1, b, 'resource'); next = b + 1; b = close(next, end); }
      const s = scope('transition', next + 1, b, parent, sym); sym.bodyScope = s; sym.hasBody = true;
      for (let j = next + 1; j < b; j++) if (t[j].kind === 'identifier') source.roles.set(j, 'action');
      sym.complete = validHeader && source.pairs.has(next);
      let expectAction = true;
      for (let j = next + 1; j < b; j++) {
        if (t[j]?.kind === 'identifier') { sym.actionTokens.push(t[j]); expectAction = false; }
        else if (!expectAction && [',', ';'].includes(value(j))) expectAction = true;
        else { sym.complete = false; break; }
      }
      sym.end = offset(b + 1); next = b + 1;
    }
    return next;
  }
  function valueDecl(i, end, parent, top) {
    const type = readType(i, end);
    if (!type || !isName(type.end)) return null;
    const n = type.end, after = n + 1;
    if (value(after) === '(' && top) {
      const pEnd = close(after, end), sym = symbol('function', n, i, pEnd + 1, parent, { type: type.type });
      mark(i, n, 'type');
      const fs = scope('function', pEnd + 1, end, parent, sym); sym.bodyScope = fs;
      for (const [a, b] of parts(after + 1, pEnd)) {
        const pt = readType(a, b);
        if (!pt) continue;
        mark(a, pt.end, 'type');
        const hasName = pt.end < b && isName(pt.end);
        const p = hasName ? symbol('parameter', pt.end, a, b, fs, { type: pt.type }) : { name: '', type: pt.type, kind: 'parameter', uri, start: offset(a), end: offset(b) };
        sym.params.push(p);
      }
      let next = pEnd + 1;
      while (next < end && !['{', ';', '}'].includes(value(next))) next++;
      attrs(pEnd + 1, next, sym);
      if (value(next) === '{') {
        const b = close(next, end); fs.start = offset(next + 1); fs.end = offset(b); fs.begin = next + 1; fs.limit = b;
        sym.hasBody = true;
        const last = parseRange(next + 1, b, fs);
        if (last < b) { fs.end = offset(last); fs.limit = last; fs.recovered = true; }
        next = last < b ? last : b + 1;
      } else { fs.end = fs.start; if (value(next) === ';') next++; }
      sym.end = offset(next); return next;
    }
    if (![';', ',', ':=', '='].includes(value(after)) && after < end) return null;
    if (!top && type.type.includes('&') && value(after) !== ':=') return null;
    const next = statementEnd(after, end), kind = ['function', 'action', 'in_port', 'peek', 'enqueue', 'block'].includes(parent.kind) ? 'variable' : 'field';
    const sym = symbol(kind, n, i, next, parent, { type: type.type }); mark(i, n, 'type');
    let assign = after;
    while (assign < next && value(assign) !== ':=') assign++;
    attrs(after, Math.min(assign, next - 1), sym);
    if (assign < next) sym.initializer = [assign + 1, next - (value(next - 1) === ';' ? 1 : 0)];
    addStatement(i, next, parent, sym); return next;
  }
  function parseOne(i, end, parent, forceTop = false) {
    const v = value(i), top = forceTop || ['file', 'machine', 'structure', 'external_type'].includes(parent.kind);
    if (v === 'include') {
      if (t[i + 1]?.kind === 'string') { source.includes.push({ path: unquote(value(i + 1)), ...range(i + 1), scope: parent }); source.roles.set(i + 1, 'include'); }
      return statementEnd(i + 1, end);
    }
    if (v === 'protocol') {
      const b = statementEnd(i + 1, end);
      if (t[i + 1]?.kind === 'string') source.protocols.push(unquote(value(i + 1)));
      mark(i, b, 'protocol'); return b;
    }
    if (['machine', 'structure', 'global', 'enumeration', 'state_declaration', 'external_type', 'action', 'in_port', 'out_port'].includes(v) && top) return named(i, end, parent);
    if (v === 'transition' && top) return transition(i, end, parent);
    if (v === 'peek' || v === 'enqueue') {
      const h = i + 1;
      if (value(h) === '(') {
        const b = close(h, end), args = parts(h + 1, b);
        if (args[1]) mark(...args[1], 'type');
        attrs(args[2]?.[0] ?? b, b);
        addStatement(i, b + 1, parent);
        if (value(b + 1) === '{') {
          const last = close(b + 1, end), tt = args[1] ? t.slice(...args[1]).map(x => x.text).join('') : '';
          const parsed = body(b + 1, last, parent, v, null, { name: v === 'peek' ? 'in_msg' : 'out_msg', type: tt, ...range(args[1]?.[0] ?? i) });
          return parsed.recovered ? parsed.limit : last + 1;
        }
        return b + 1;
      }
    }
    if (v === 'if') {
      const b = value(i + 1) === '(' ? close(i + 1, end) + 1 : i + 1;
      addStatement(i, b, parent); return b;
    }
    if (v === 'else') return i + 1;
    if (v === '{') { const b = close(i, end), parsed = body(i, b, parent, 'block'); return parsed.recovered ? parsed.limit : b + 1; }
    const declEnd = valueDecl(i, end, parent, top);
    if (declEnd !== null) return declEnd;
    if (v === ';' || v === '}') return i + 1;
    const b = statementEnd(i, end); addStatement(i, b, parent); return Math.max(i + 1, b);
  }
  function parseRange(begin, end, parent) {
    let i = begin;
    while (i < end) {
      if (!['file', 'machine', 'structure', 'external_type'].includes(parent.kind) && declarationStarts.has(value(i))) break;
      const next = parseOne(i, end, parent); i = Math.max(i + 1, next);
    }
    return i;
  }
  parseRange(0, t.length, fileScope);
  source.scopeAt = position => {
    let best = fileScope;
    for (const s of source.scopes) if (s.start <= position && position <= s.end && (s.start >= best.start && s.end <= best.end)) best = s;
    return best;
  };
  source.tokenAt = position => {
    let lo = 0, hi = t.length - 1;
    while (lo <= hi) { const m = (lo + hi) >>> 1; if (position < t[m].start) hi = m - 1; else if (position >= t[m].end) lo = m + 1; else return t[m]; }
    return undefined;
  };
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  source.positionAt = offset => {
    offset = Math.max(0, Math.min(text.length, offset));
    let lo = 0, hi = lineStarts.length;
    while (lo < hi) { const middle = (lo + hi) >>> 1; if (lineStarts[middle] > offset) hi = middle; else lo = middle + 1; }
    const line = lo - 1; let end = lineStarts[line + 1] ?? text.length;
    if (text[end - 1] === '\n') end--; if (text[end - 1] === '\r') end--;
    return { line, character: Math.max(0, Math.min(offset, end) - lineStarts[line]) };
  };
  return source;
}

function ownerOf(scope, kinds) { for (let s = scope; s; s = s.parent) if (s.owner && kinds.has(s.owner.kind)) return s.owner; }
module.exports = { parse, typeKinds, callableKinds, ownerOf };

'use strict';

const { lex } = require('./lexer');

// A source-level recognizer: skip comments, strings, forward declarations and bodies.
// It does not evaluate a preprocessor or follow arbitrary C++ alias expressions.
function parseCpp(uri, text) {
  const t = lex(text).tokens, out = [], stack = [], namespaces = [];
  const name = i => t[i]?.text;
  const qualified = local => [...namespaces, ...local.split('::')].filter(Boolean).join('::');
  function emit(i, kind, qualifiedName) {
    if (t[i]) out.push({ uri, name: t[i].text, qualifiedName: qualifiedName ?? qualified(t[i].text), kind, start: t[i].start, end: t[i].end });
  }
  for (let i = 0; i < t.length; i++) {
    if (name(i) === 'namespace') {
      const parts = []; let j = i + 1;
      while (t[j]?.kind === 'identifier' || name(j) === '::') { if (name(j) !== '::') parts.push(name(j)); j++; }
      if (name(j) === '{') { stack.push({ namespace: parts.length }); namespaces.push(...parts); i = j; continue; }
    }
    if (['class', 'struct', 'enum', 'union'].includes(name(i)) && !(name(i - 1) === 'enum' || (name(i - 1) === '<' || name(i - 1) === ',') && name(i) === 'class')) {
      let n = i + 1; if (name(i) === 'enum' && ['class', 'struct'].includes(name(n))) n++;
      if (t[n]?.kind === 'identifier') {
        let j = n + 1, depth = 0;
        for (; j < t.length && j < n + 200; j++) {
          if (name(j) === '<') depth++; else if (name(j) === '>') depth--;
          if (depth <= 0 && ['{', ';', '=', ')'].includes(name(j))) break;
        }
        if (name(j) === '{') {
          emit(n, name(i)); stack.push({ namespace: 1 }); namespaces.push(name(n)); i = j; continue;
        }
      }
    }
    if (name(i) === 'using' && t[i + 1]?.kind === 'identifier' && name(i + 2) === '=') emit(i + 1, 'alias');
    if (name(i) === 'typedef') {
      let j = i + 1; while (j < t.length && ![';', '{', '}'].includes(name(j))) j++;
      if (name(j) === ';' && t[j - 1]?.kind === 'identifier') emit(j - 1, 'alias');
    }
    if (name(i) === '{') stack.push({ namespace: 0 });
    if (name(i) === '}' && stack.length) { const s = stack.pop(); if (s.namespace) namespaces.splice(-s.namespace); }
  }
  return out;
}

function externalTypeName(sym) {
  let name = (sym.attributes.external_name || sym.name).trim().replace(/<.*>/g, '').replace(/[&*]/g, '').trim();
  if (['InPort', 'OutPort'].includes(name)) name = 'MessageBuffer';
  return name;
}
function externalNames(sym, { protocol, machine } = {}) {
  if (sym.kind !== 'external_type' && !(sym.kind === 'structure' && sym.attributes.external === 'yes')) return undefined;
  const name = externalTypeName(sym);
  if (name === 'Scalar' || /^(?:(?:unsigned|signed|long|short)\s*)*(?:void|bool|char|int|float|double|size_t|u?int\d+_t)$/.test(name) || /^(?:::)?std::/.test(name)) return [];
  if (name.startsWith('::')) return [name.slice(2)];
  if (name.startsWith('gem5::')) return [name];
  const names = ['gem5::ruby::' + name];
  if (protocol && !name.includes('::')) {
    const qualified = `gem5::ruby::${protocol}::${name}`;
    if (machine) names.unshift(qualified); else names.push(qualified);
  }
  if (sym.kind === 'external_type') names.push('gem5::' + name);
  return names;
}

module.exports = { parseCpp, externalNames, externalTypeName };

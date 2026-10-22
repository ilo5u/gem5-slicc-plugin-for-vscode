'use strict';

const { builtinNames, primitives } = require('./lexer');
const { ownerOf } = require('./parser');
const { callArguments } = require('./calls');

function callError(analysis, i) {
  const { source, t, index } = analysis, name = t[i]?.text, at = t[i]?.start, prev = t[i - 1]?.text;
  if (t[i]?.kind !== 'identifier' || t[i + 1]?.text !== '(' || source.declarations.has(i) || !callArguments(source, i + 1)) return undefined;
  if (['.', ':', 'new'].includes(prev) || !index.contextComplete(source, at)) return undefined;
  if (prev === '::') {
    let begin = i - 2;
    while (t[begin - 1]?.text === '::' && t[begin - 2]?.kind === 'identifier') begin -= 2;
    const nameOwner = t.slice(begin, i - 1).map(token => token.text).join(''), types = index.types(source, at, nameOwner);
    if (types.length !== 1) return undefined;
    const members = analysis.members(types[0], at);
    if (members.complete && !members.symbols.some(s => s.kind === 'function' && s.name === name)) return `Type '${nameOwner}' has no function '${name}'`;
    return undefined;
  }
  if (builtinNames.has(name) || primitives.has(name) || ['char', 'unsigned', 'long'].includes(name)) return undefined;
  if (analysis.visibleVariables(at).some(s => s.name === name) || index.types(source, at, name).length) return undefined;
  if (analysis.port(name, at).known || analysis.generated(i)) return undefined;
  if (index.visible(source, at).some(s => s.kind === 'machine' && name.startsWith(s.name + '_'))) return undefined;
  const owner = ownerOf(source.scopeAt(at), new Set(['structure', 'external_type']));
  if (owner) {
    const members = analysis.members(owner, at);
    if (!members.complete || members.symbols.some(s => s.kind === 'function' && s.name === name)) return undefined;
  }
  return analysis.call(i)?.allCandidates.length ? undefined : `No function '${name}' is visible in this scope`;
}

module.exports = { callError };

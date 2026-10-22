'use strict';

const { Analysis } = require('./analysis');
const { keywords, primitives, constants, builtinNames, baseType } = require('./lexer');
const { printfDiagnostics } = require('./printf');
const { transitionDiagnostics } = require('./transitions');
const { callError } = require('./call-diagnostics');

function diagnostics(index, source, options = {}, cancelled) {
  const out = source.issues.map(x => ({ severity: 'error', ...x }));
  // Broken delimiters can move subsequent declarations into the wrong scope.
  // Keep the primary syntax error and defer semantic cascades until it is fixed.
  if (source.issues.length) return out;
  const analysis = new Analysis(index, source, cancelled), t = source.tokens;
  const report = (token, message, code) => out.push({ start: token.start, end: token.end, message, code, severity: 'error' });
  const machines = index.visible(source, 0).filter(x => x.kind === 'machine').map(x => x.name);
  for (const include of source.includes) if (!index.includeTarget(source, include)) report(include, `Cannot resolve include '${include.path}'`, 'include');
  for (let i = 0; i < t.length; i++) {
    if (cancelled?.()) return out;
    const token = t[i], name = token.text, role = source.roles.get(i), prev = t[i - 1]?.text, next = t[i + 1]?.text;
    if (source.declarations.has(i) || token.kind !== 'identifier' || ['attribute', 'resource', 'protocol', 'type'].includes(role)) continue;
    if (keywords.has(name) || primitives.has(name) || constants.has(name) || builtinNames.has(name)) continue;
    if (next === '::' || next === '=' || prev === '::' && next !== '(') continue;
    if (prev === '(' && t[i - 2]?.text === 'DPRINTF') continue;
    if (next === '(' && prev !== '.' && prev !== ':') {
      if (options.calls !== false) { const error = callError(analysis, i); if (error) report(token, error, 'call'); }
      continue;
    }
    if (role === 'action') continue; // The transition checker validates complete bodies.
    const resolved = analysis.resolve(i);
    if (resolved.length) continue;
    if (analysis.enumDefault(i)?.deferred || analysis.port(name, token.start).known) continue;
    if (prev === '.') {
      if (options.members === false) continue;
      // The CLion diagnostic is deliberately name-only and supports simple receivers.
      const begin = analysis.expressionStart(i - 2), receiverTokens = t.slice(begin, i - 1);
      if (!receiverTokens.length || receiverTokens.some((x, j) => j % 2 ? x.text !== '.' : x.kind !== 'identifier')) continue;
      const receiver = analysis.receiver(i - 1);
      if (!receiver.type) continue;
      const members = analysis.members(receiver.type, receiver.at ?? token.start, receiver.source ?? source);
      if (members.complete && !members.symbols.some(x => x.name === name)) report(token, `Unknown member '${name}' of '${baseType(receiver.type)}'`, 'member');
      continue;
    }
    if (prev === ':') continue;
    if (['in_msg', 'out_msg'].includes(name)) {
      report(token, `'${name}' is only available inside a ${name === 'in_msg' ? 'peek' : 'enqueue'} block or as an explicit declaration`, 'message-scope');
      continue;
    }
    if (machines.some(machine => name.startsWith(machine + '_'))) continue;
    report(token, `Unresolved symbol '${name}'`, 'unresolved');
  }
  if (options.functionResults !== false) checkResults(analysis, out);
  if (options.printf !== false) out.push(...printfDiagnostics(source, options.debugFlags, cancelled));
  if (options.transitions !== false) out.push(...transitionDiagnostics(index, source, cancelled));
  return out;
}

function checkResults(a, out) {
  const { source, t } = a;
  const emit = (begin, end, message) => {
    if (t[begin] && t[end - 1]) out.push({ start: t[begin].start, end: t[end - 1].end, message, severity: 'error', code: 'function-result' });
  };
  for (let i = 0; i < t.length; i++) {
    if (a.cancelled()) return;
    if (t[i].kind !== 'identifier' || a.get(i + 1) !== '(' || source.declarations.has(i)) continue;
    const call = a.call(i);
    if (!call?.complete || !call.candidates.length) continue;
    call.arguments.forEach((arg, n) => {
      if (!arg.value.hasCall || !arg.value.type) return;
      const all = call.candidates.filter(s => s.params.length === call.arguments.length);
      const relevant = all.filter(s => s.params.every((p, j) => j === n || a.compatibility(call.arguments[j].value, a.typed(p)) !== false));
      const candidates = relevant.length ? relevant : all;
      if (!candidates.length) return;
      if (baseType(arg.value.type) === 'void') emit(arg.begin, arg.end, 'Void function result cannot be used as an argument');
      else if (candidates.every(s => a.compatibility(arg.value, a.typed(s.params[n])) === false)) {
        const expected = [...new Set(candidates.map(s => s.params[n].type))].join("' or '");
        emit(arg.begin, arg.end, `Function result type '${arg.value.type}' is incompatible with parameter ${n + 1} of '${call.name}' (expected '${expected}')`);
      }
    });
  }
  for (const statement of source.statements) {
    if (a.cancelled()) return;
    let assign = -1;
    for (let i = statement.begin; i < statement.limit; i++) {
      if (a.get(i) === ':=') { if (assign !== -1) { assign = -1; break; } assign = i; }
      else if (source.pairs.get(i) > i) i = source.pairs.get(i);
    }
    if (assign < 0 || a.get(statement.limit - 1) !== ';') continue;
    const expected = statement.declaration ? a.typed(statement.declaration) : a.infer(statement.begin, assign);
    const actual = a.infer(assign + 1, statement.limit - 1);
    if (!expected.type || !actual.type || !actual.hasCall) continue;
    if (baseType(actual.type) === 'void') emit(assign + 1, statement.limit - 1, 'Void function result cannot be assigned to a variable');
    else if (baseType(expected.type) !== 'NetDest' && baseType(actual.type) !== 'Set' && a.compatibility(actual, expected) === false && a.compatibility(expected, actual) !== true) {
      emit(assign + 1, statement.limit - 1, `Cannot assign function result of type '${actual.type}' to variable of type '${expected.type}'`);
    }
  }
}

module.exports = { diagnostics };

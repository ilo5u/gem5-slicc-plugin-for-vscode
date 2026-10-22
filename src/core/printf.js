'use strict';

const { callArguments } = require('./calls');

function literal(tokens) {
  let value = '';
  if (!tokens.length) return undefined;
  for (const token of tokens) {
    if (token.kind !== 'string' || token.text.length < 2 || token.text.at(-1) !== token.text[0]) return undefined;
    const text = token.text.slice(1, -1);
    for (let i = 0; i < text.length; i++) {
      let c = text[i];
      if (c === '\\') {
        c = text[++i];
        if (c === '\n') continue;
        if (c === '\r' && text[i + 1] === '\n') { i++; continue; }
        if (!c || !'"\'\\?abfnrtv'.includes(c)) return undefined;
      }
      value += c;
    }
  }
  return value;
}

function argumentCount(format) {
  let count = 0;
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') continue;
    i++; if (i >= format.length) return undefined;
    if (format[i] === '%') continue;
    while (i < format.length && "-+ #0'".includes(format[i])) i++;
    if (format[i] === '*') { count++; i++; } else while (/[0-9]/.test(format[i] ?? '')) i++;
    if (format[i] === '.') {
      i++; if (format[i] === '*') { count++; i++; } else while (/[0-9]/.test(format[i] ?? '')) i++;
    }
    if (i < format.length && 'hljztL'.includes(format[i])) {
      const length = format[i++]; if ((length === 'h' || length === 'l') && format[i] === length) i++;
    }
    if (i >= format.length || !'diuoxXfFeEgGaAcspnb'.includes(format[i])) return undefined;
    count++;
  }
  return count;
}

function printfDiagnostics(source, flags, cancelled = () => false) {
  if (source.issues.length) return [];
  const t = source.tokens, out = [];
  const emit = (range, message, code = 'printf', severity = 'error') => out.push({ start: range.start, end: range.end, message, code, severity });
  for (let i = 0; i < t.length; i++) {
    if (cancelled()) break;
    const name = t[i].text;
    if (!['DPRINTF', 'DPRINTFN'].includes(name) || ['.', ':', '::'].includes(t[i - 1]?.text) || source.declarations.has(i)) continue;
    const args = callArguments(source, i + 1); if (!args) continue;
    const flagged = name === 'DPRINTF', formatIndex = flagged ? 1 : 0;
    if (flagged) {
      const [a, b] = args[0] ?? [];
      if (a === undefined || b !== a + 1 || t[a].kind !== 'identifier') {
        emit(t[i], 'DPRINTF requires a debug flag before its format string', 'debug-flag'); continue;
      }
      if (flags?.complete && !flags.flags.some(flag => flag.name === t[a].text)) emit(t[a], `Unknown debug flag '${t[a].text}' in project SConscript declarations`, 'debug-flag');
    }
    if (!args[formatIndex]) { emit(t[i], `${name} requires a format string`); continue; }
    const [a, b] = args[formatIndex], format = literal(t.slice(a, b));
    if (format === undefined) continue;
    const expected = argumentCount(format), actual = args.length - formatIndex - 1;
    if (expected !== undefined && expected !== actual) emit({ start: t[a].start, end: t[b - 1].end }, `${name} format expects ${expected} argument(s), but ${actual} provided`, 'printf', 'warning');
  }
  return out;
}

function debugFlagPosition(source, offset) {
  const t = source.tokens;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i].text !== 'DPRINTF' || t[i + 1]?.text !== '(' || ['.', ':', '::'].includes(t[i - 1]?.text) || t[i + 1].end > offset) continue;
    const close = source.pairs.get(i + 1);
    if (close !== undefined && offset > t[close].start) continue;
    let end = t.length;
    for (let j = i + 2; j < t.length; j++) if ([',', ')', ';'].includes(t[j].text)) { end = j; break; }
    if (end < t.length && offset > t[end].start) continue;
    const between = t.slice(i + 2, end).filter(token => token.start < offset);
    return between.length <= 1 && (!between.length || between[0].kind === 'identifier');
  }
  return false;
}

module.exports = { argumentCount, literal, printfDiagnostics, debugFlagPosition };

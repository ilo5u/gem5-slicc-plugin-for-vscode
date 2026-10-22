'use strict';

// All offsets are JavaScript / VS Code UTF-16 offsets, including CRLF sources.
const declarations = 'machine structure enumeration external_type state_declaration in_port out_port action transition include protocol global'.split(' ');
const controls = 'if else return'.split(' ');
const outputBuiltins = new Set(['DPRINTF', 'DPRINTFN', 'APPEND_TRANSITION_COMMENT']);
const voidBuiltins = new Set([...outputBuiltins, 'stallPort']);
const builtins = 'peek enqueue trigger stall_and_wait wakeup_port check_allocate check_next_cycle check_stop_slots check_on_cache_probe OOD defer_enqueueing static_cast new DPRINTF DPRINTFN APPEND_TRANSITION_COMMENT stallPort is_valid is_invalid'.split(' ');
const attributes = 'desc main in_trans out_trans default network virtual_network vnet_type rank return_by_pointer return_by_ref interface external primitive ordered template constructor non_obj implicit_ctor buffer inport outport external_name block_on format wake_up rsc_stall_handler prot_stall_handler'.split(' ');
const keywords = new Set([...declarations, ...controls, ...builtins, ...attributes, 'void']);
const primitives = new Set(['void', 'bool', 'int', 'float', 'double', 'string']);
const constants = new Set(['true', 'false', 'null', 'NULL']);
const builtinNames = new Set(['error', 'assert', 'APPEND_TRANSITION_COMMENT', ...builtins]);
const gem5Types = 'Addr Cycles Tick DataBlock MachineID NetDest MessageBuffer CacheMemory Sequencer RubyRequest RubyRequestType MachineType AccessPermission TBE Entry State Event'.split(' ');

function lex(text) {
  const tokens = [], comments = [], issues = [];
  let i = 0;
  while (i < text.length) {
    const start = i, c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
      comments.push({ kind: 'comment', text: text.slice(start, i), start, end: i });
      continue;
    }
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
      comments.push({ kind: 'comment', text: text.slice(start, i), start, end: i });
      if (close < 0) issues.push({ start, end: start + 2, message: 'Unterminated block comment', code: 'syntax' });
      continue;
    }
    let kind = 'operator';
    if (c === '"' || c === "'") {
      kind = 'string'; i++;
      while (i < text.length && text[i] !== c) { if (text[i] === '\\') i++; i++; }
      if (i >= text.length) issues.push({ start, end: Math.min(start + 1, text.length), message: 'Unterminated string', code: 'syntax' });
      else i++;
    } else if (/[A-Za-z_]/.test(c)) {
      i++;
      while (i < text.length && /[\w]/.test(text[i])) i++;
      kind = keywords.has(text.slice(start, i)) ? 'keyword' : 'identifier';
    } else if (/[0-9]/.test(c)) {
      kind = 'number';
      const match = /^(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?)(?:[eE][+-]?\d+)?)[uUlLfF]*/.exec(text.slice(i));
      i += match[0].length;
    } else {
      const op = /^(?::=|::|==|!=|<=|>=|&&|\|\||<<|>>|->|\+\+|--|\+=|-=)/.exec(text.slice(i));
      i += op ? op[0].length : 1;
    }
    tokens.push({ kind, text: text.slice(start, i), start, end: i, index: tokens.length });
  }
  return { tokens, comments, issues };
}

function unquote(value) { return value && /^["']/.test(value) ? value.slice(1, -1) : value; }
function baseType(type) { return (type || '').replace(/\bconst\b/g, '').replace(/[&*\s]/g, ''); }
function typeKey(type) { return (type || '').replace(/\s/g, ''); }

function decodeDescription(value) { return value?.replace(/\\([nrt\\"'])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c); }

module.exports = { lex, unquote, baseType, typeKey, keywords, primitives, constants, builtinNames, declarations, controls, builtins, attributes, gem5Types, outputBuiltins, voidBuiltins, decodeDescription };

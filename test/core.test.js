'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceIndex } = require('../src/core/index');
const { Analysis, signature } = require('../src/core/analysis');
const { lex } = require('../src/core/lexer');
const { diagnostics } = require('../src/core/diagnostics');
const { hints } = require('../src/core/hints');
const { parseCpp, externalNames } = require('../src/core/cpp');
const { ExternalTypes } = require('../src/core/build-scope');

function setup(files, main = 'cache.sm') {
  const index = new WorkspaceIndex();
  for (const [name, text] of Object.entries(files)) index.set(`file:///test/${name}`, text);
  const source = index.sources.get(`file:///test/${main}`), analysis = new Analysis(index, source);
  const token = (text, occurrence = 0) => source.tokens.filter(t => t.text === text)[occurrence];
  return { index, source, analysis, token };
}
function target(s, word, occurrence) { return s.analysis.resolve(s.token(word, occurrence).index)[0]; }
function issues(s) { return diagnostics(s.index, s.source); }

test('lexer handles escaped strings, comments, scoped names, OOD and UTF-16 / CRLF', () => {
  const text = '// 😀\r\nmain OOD ood std::string x := "a\\\"b"; /* hi */';
  const result = lex(text); assert.equal(result.issues.length, 0); assert.equal(result.comments.length, 2);
  assert.equal(result.tokens[0].text, 'main'); assert.equal(result.tokens[0].start, text.indexOf('main'));
  assert.equal(result.tokens[1].kind, 'keyword'); assert.equal(result.tokens[2].kind, 'identifier');
  assert.ok(result.tokens.some(t => t.text === ':='));
});

test('reference and pointer parameters retain modifiers and names', () => {
  const s = setup({ 'cache.sm': 'structure(Msg) { int Value; } void use(Msg & out_msg, Msg * other) { out_msg.Value := other.Value; }' });
  const fn = s.source.symbols.find(x => x.kind === 'function');
  assert.equal(fn.params.length, 2); assert.equal(fn.params[0].name, 'out_msg'); assert.match(signature(fn), /Msg & out_msg, Msg \* other/);
  assert.equal(target(s, 'Value', 1).name, 'Value'); assert.equal(issues(s).length, 0);
});

test('port methods and attribute-shaped parameter names remain declarations', () => {
  const s = setup({ 'cache.sm': 'structure(InPort) { bool isReady(int current_time); int dequeue(int current_time); void use(int buffer); } InPort q; void f() { q.isReady(1); q.dequeue(2); }' });
  assert.deepEqual(s.analysis.members('InPort', s.token('q').start).symbols.map(x => x.name), ['isReady', 'dequeue', 'use']);
  assert.equal(target(s, 'isReady', 1).params[0].name, 'current_time');
  assert.deepEqual(hints(s.index, s.source).map(h => h.label), ['current_time:', 'current_time:']);
});

test('source positions preserve UTF-16 columns and CRLF line boundaries', () => {
  const s = setup({ 'cache.sm': '// 😀\r\nint value;\r\n' });
  assert.deepEqual(s.source.positionAt(s.token('value').start), { line: 1, character: 4 });
  assert.deepEqual(s.source.positionAt(s.source.text.length), { line: 2, character: 0 });
});

test('untitled buffers resolve their own symbols without a filesystem URI', () => {
  const index = new WorkspaceIndex(), source = index.set('untitled:Untitled-1', 'structure(A) { int Value; } A a; void f() { a.Value; }');
  assert.equal(diagnostics(index, source).length, 0);
});

test('preceding locals and block visibility preserve shadowing', () => {
  const s = setup({ 'cache.sm': 'int item; void f(int item) { item := 1; { bool item; item := true; } item := 3; missing := 0; }' });
  assert.equal(target(s, 'item', 2).kind, 'parameter'); assert.equal(target(s, 'item', 4).type, 'bool'); assert.equal(target(s, 'item', 5).kind, 'parameter');
  assert.equal(issues(s).filter(i => i.code === 'unresolved').length, 1);
});

test('nested messages use the nearest matching block and do not leak', () => {
  const s = setup({ 'cache.sm': 'structure(A) { int Outer; } structure(B) { int Inner; } int q; void f() { peek(q, A) { in_msg.Outer; enqueue(q, B) { in_msg.Outer; out_msg.Inner; } peek(q, B) { in_msg.Inner; } in_msg.Outer; } in_msg.Outer; out_msg.Inner; }' });
  assert.equal(target(s, 'Outer', 1).name, 'Outer'); assert.equal(target(s, 'Inner', 2).name, 'Inner');
  assert.equal(issues(s).filter(i => i.code === 'message-scope').length, 2);
  const types = hints(s.index, s.source).filter(x => x.kind === 'type').map(x => x.label);
  assert.deepEqual(types, [': A', ': B', ': B']);
});

test('explicit message parameters override peek/enqueue bindings', () => {
  const s = setup({ 'cache.sm': 'structure(A) { int Outer; } structure(B) { int Inner; } int q; void f(A & in_msg, A & out_msg) { peek(q, B) { in_msg.Outer; enqueue(q, B) { out_msg.Outer; } } in_msg.Outer; }' });
  assert.equal(issues(s).length, 0); assert.equal(target(s, 'in_msg', 1).kind, 'parameter');
  assert.equal(hints(s.index, s.source).filter(x => x.kind === 'type').length, 0);
});

test('protocol and machine include scopes isolate same-named types and methods', () => {
  const s = setup({
    'P.slicc': 'include "cache.sm"; include "other.sm"; include "messages.sm";',
    'messages.sm': 'structure(Msg) { int Payload; }',
    'cache.sm': 'machine(MachineType:Cache) { structure(Entry, interface="AbstractCacheEntry") { int First; } include "actions.sm"; }',
    'other.sm': 'machine(MachineType:Other) { structure(Entry, interface="AbstractCacheEntry") { int Second; } action(b, "b") { cache_entry.Second; } }',
    'actions.sm': 'action(a, "a") { cache_entry.First; }'
  }, 'actions.sm');
  assert.equal(target(s, 'First').name, 'First'); assert.equal(issues(s).length, 0);
  const members = s.analysis.members('Entry', s.token('First').start).symbols;
  assert.deepEqual(members.map(x => x.name), ['First']);
});

test('global interfaces are scoped to their nearest source tree', () => {
  const s = setup({ 'RubySlicc_interfaces.slicc': 'include "types.sm";', 'types.sm': 'structure(Glob) { int ok; }', 'cache.sm': 'Glob value; void f() { value.ok; }', 'other/RubySlicc_interfaces.slicc': 'structure(Glob) { int wrong; }' });
  assert.equal(target(s, 'ok').name, 'ok'); assert.equal(issues(s).length, 0);
});

test('overloads select by argument type and connect prototypes with definitions', () => {
  const s = setup({ 'cache.sm': 'int f(int x); int f(int x) { return x; } bool f(bool x) { return x; } void g() { int n := f(1); bool b := f(true); }' });
  assert.equal(target(s, 'f', 3).type, 'int'); assert.equal(target(s, 'f', 3).hasBody, true); assert.equal(target(s, 'f', 4).type, 'bool');
  assert.equal(issues(s).length, 0);
  const prototype = s.source.symbols.find(x => x.kind === 'function' && !x.hasBody);
  assert.equal(s.analysis.references(prototype).length, 1);
});

test('signature candidates retain overloads with different argument counts', () => {
  const s = setup({ 'cache.sm': 'int pick(int first); int pick(int first, bool ready); void f() { pick(1); }' });
  const call = s.analysis.call(s.token('pick', 2).index);
  assert.equal(call.selected.length, 1); assert.equal(call.allCandidates.length, 2);
});

test('shared prototypes resolve calls in each including machine', () => {
  const s = setup({
    'cache.sm': 'machine(MachineType:A) { include "shared.sm"; int pick(int n) { return n; } action(a, "a") { pick(1); } }',
    'b.sm': 'machine(MachineType:B) { include "shared.sm"; int pick(int n) { return n; } action(b, "b") { pick(2); } }',
    'shared.sm': 'int pick(int n);'
  });
  assert.equal(target(s, 'pick', 1).uri, 'file:///test/cache.sm');
  const prototype = s.index.sources.get('file:///test/shared.sm').symbols[0];
  assert.equal(s.analysis.references(prototype).length, 2);
});

test('scoped C++ external names retain their complete declaration identity', () => {
  const s = setup({ 'cache.sm': 'external_type(std::string, primitive="yes"); external_type(prefetch::Base); std::string text;' });
  assert.equal(s.source.symbols[0].name, 'std::string');
  assert.deepEqual(externalNames(s.source.symbols[0]), []);
  assert.equal(s.index.types(s.source, 0, 'prefetch::Base').length, 1);
  assert.equal(issues(s).length, 0);
});

test('inherited members are available and incomplete or cyclic interfaces defer errors', () => {
  const s = setup({ 'cache.sm': 'structure(Base) { int A; } structure(Child, interface="Base") { bool B; } structure(Broken, interface="Missing") {} structure(Loop, interface="Loop") {} Child c; Broken b; Loop l; void f() { c.A; c.No; b.No; l.No; c.No.Downstream; }' });
  assert.equal(target(s, 'A', 1).name, 'A');
  const members = issues(s).filter(i => i.code === 'member'); assert.equal(members.length, 2); assert.ok(members.every(i => s.source.text.slice(i.start, i.end) === 'No'));
});

test('function results check assignments and inner-call arguments, including void', () => {
  const s = setup({ 'cache.sm': 'int num() { return 1; } bool flag() { return true; } void empty() {} void accept(int n) {} void f() { bool b := num(); int n := empty(); accept(flag()); accept(empty()); bool good := flag(); }' });
  const results = issues(s).filter(i => i.code === 'function-result');
  assert.equal(results.length, 4); assert.ok(results.some(i => /cannot be assigned/.test(i.message))); assert.ok(results.some(i => /cannot be used as an argument/.test(i.message)));
});

test('unknown and complex expressions defer function-result checks', () => {
  const s = setup({ 'cache.sm': 'int num() { return 1; } void f() { bool b := num() + 1; Mystery x := num(); int a := unknown(); }' });
  assert.equal(issues(s).filter(i => i.code === 'function-result').length, 0);
});

test('an incomplete expected interface hierarchy defers incompatibility', () => {
  const s = setup({ 'cache.sm': 'structure(A) {} structure(B, interface="Missing") {} A get(); void take(B arg); void f() { B b := get(); take(get()); }' });
  assert.equal(issues(s).filter(i => i.code === 'function-result').length, 0);
});

test('primitive external types remain nominal; no blanket numeric conversions', () => {
  const s = setup({ 'cache.sm': 'external_type(Addr, primitive="yes"); external_type(Cycles, primitive="yes"); Addr addr() { return 0; } void take(Cycles n) {} void f() { Cycles c := addr(); take(addr()); }' });
  assert.equal(issues(s).filter(i => i.code === 'function-result').length, 2);
});

test('NetDest / Set assignment exemptions do not exempt function arguments', () => {
  const s = setup({ 'cache.sm': 'structure(NetDest) {} structure(Set) {} structure(Other) {} Set makeSet(); Other makeOther(); void take(Other x); void f() { NetDest n := makeOther(); Other o := makeSet(); take(makeSet()); }' });
  assert.equal(issues(s).filter(i => i.code === 'function-result').length, 1);
});

test('parameter hints omit repeated names and preserve overload agreement', () => {
  const s = setup({ 'cache.sm': 'void use(int count, bool ready); void f(int count) { use(1, true); use(count, false); }' });
  assert.deepEqual(hints(s.index, s.source).filter(x => x.kind === 'parameter').map(x => x.label), ['count:', 'ready:', 'ready:']);
});

test('action implicit hints occur once in each action and respect explicit declarations', () => {
  const s = setup({ 'cache.sm': 'machine(MachineType:Cache) { structure(Entry, interface="AbstractCacheEntry") { int V; } action(a, "a") { cache_entry.V; cache_entry.V; address; } action(b, "b") { cache_entry.V; int address; address; } }' });
  assert.deepEqual(hints(s.index, s.source).filter(x => x.kind === 'type').map(x => x.label), [': Entry', ': Addr', ': Entry']);
});

test('transition roles distinguish states, events, resources and action usages', () => {
  const s = setup({ 'cache.sm': 'machine(MachineType:Cache) { state_declaration(State) { I; S; } enumeration(Event) { Load; } action(a, "a") {} transition(I, Load, S) { a; } transition({I,S}, Load) {TagArrayRead} { a; } }' });
  const action = s.source.symbols.find(x => x.kind === 'action');
  assert.equal(s.analysis.related(action).length, 2); assert.equal(target(s, 'I', 1).kind, 'enumMember'); assert.equal(issues(s).filter(i => i.code === 'transition-duplicate').length, 1);
  const event = s.source.symbols.find(x => x.kind === 'enumMember' && x.name === 'Load');
  assert.ok(s.analysis.related(event).every(ref => ref.source.text.slice(ref.start, ref.end).startsWith('transition')));
});

test('reverse action usages include all machines that include a shared action file', () => {
  const s = setup({ 'cache.sm': 'machine(MachineType:A) { include "actions.sm"; transition(I, Load) { a; } }', 'b.sm': 'machine(MachineType:B) { include "actions.sm"; transition(I, Load) { a; } }', 'actions.sm': 'action(a, "a") {}' }, 'actions.sm');
  assert.equal(s.analysis.related(s.source.symbols[0]).length, 2);
});

test('member references respect receiver ownership and statement deduplication', () => {
  const s = setup({ 'cache.sm': 'structure(A) { int Value; } structure(B) { int Value; } A a; B b; void f() { a.Value := a.Value; b.Value := 0; }' });
  const field = s.source.symbols.find(x => x.kind === 'field' && x.name === 'Value');
  assert.equal(s.analysis.references(field).length, 2); assert.equal(s.analysis.related(field).length, 1);
});

test('include cycles terminate and changes invalidate lookup caches', () => {
  const s = setup({ 'cache.sm': 'include "b.sm"; int f() { return value; }', 'b.sm': 'include "cache.sm"; int value;' });
  assert.equal(issues(s).length, 0); s.index.set('file:///test/b.sm', 'include "cache.sm"; int other;');
  assert.ok(diagnostics(s.index, s.source).some(x => x.message.includes('value')));
});

test('constructor and prototype-shaped attribute names are ordinary tokens', () => {
  const s = setup({ 'cache.sm': 'structure(T) {} T t, constructor="m_entries", __proto__="value";' });
  assert.equal(issues(s).length, 0);
  assert.equal(s.source.symbols.find(s => s.name === 't').attributes.constructor, 'm_entries');
});

test('malformed buffers recover without looping or cascading member errors', () => {
  for (const text of ['machine(', 'structure(A) { int x;', 'void f(A & a) { a.', 'action(a, "a") { peek(q, Msg) { in_msg.', '/* unfinished']) {
    const s = setup({ 'cache.sm': text }); assert.ok(issues(s).length > 0);
  }
});

test('C++ recognizer finds namespaces, nested types and aliases, skipping forward declarations', () => {
  const defs = parseCpp('file:///x.hh', 'namespace gem5::ruby { class Forward; template <class T> class Table { public: struct Entry {}; }; using Node = int; typedef unsigned int NodeID; /* class Fake {}; */ } namespace unrelated { class Table {}; }');
  assert.deepEqual(defs.map(d => d.qualifiedName), ['gem5::ruby::Table', 'gem5::ruby::Table::Entry', 'gem5::ruby::Node', 'gem5::ruby::NodeID', 'unrelated::Table']);
});

test('external mappings use overrides, templates, namespaces and exemptions', () => {
  assert.deepEqual(externalNames({ kind: 'external_type', name: 'Addr', attributes: {} }), ['gem5::ruby::Addr', 'gem5::Addr']);
  assert.deepEqual(externalNames({ kind: 'structure', name: 'InPort', attributes: { external: 'yes' } }), ['gem5::ruby::MessageBuffer']);
  assert.deepEqual(externalNames({ kind: 'structure', name: 'X', attributes: { external: 'yes', external_name: '::other::Table<int>' } }), ['other::Table']);
  assert.deepEqual(externalNames({ kind: 'external_type', name: 'std::string', attributes: {} }), []);
});

test('external build graph follows literal sources and forwarding headers, within Ruby root', async () => {
  const files = new Map(Object.entries({
    'file:///gem5/src/mem/ruby/Kconfig': 'rsource "protocol/Kconfig"',
    'file:///gem5/src/mem/ruby/protocol/Kconfig': '',
    'file:///gem5/src/mem/ruby/SConscript': 'MakeInclude("network/MessageBuffer.hh")\nSLICC_INCLUDES = ["common/Types.hh"]\n# Source("ignored.cc")',
    'file:///gem5/src/mem/ruby/network/SConscript': 'Source("MessageBuffer.cc")',
    'file:///gem5/src/mem/ruby/network/MessageBuffer.cc': '#include "mem/ruby/protocol/MessageBuffer.hh"',
    'file:///gem5/src/mem/ruby/network/MessageBuffer.hh': 'namespace gem5 { namespace ruby { class MessageBuffer {}; }}',
    'file:///gem5/src/mem/ruby/common/Types.hh': 'namespace gem5::ruby { typedef int NodeID; }',
    'file:///gem5/src/mem/ruby/ignored.cc': 'namespace gem5::ruby { class Unreachable {}; }',
    'file:///unrelated/MessageBuffer.hh': 'namespace gem5::ruby { class MessageBuffer {}; }'
  }));
  const host = { read: async uri => files.get(uri), exists: async uri => files.has(uri) || [...files.keys()].some(k => k.startsWith(uri.endsWith('/') ? uri : uri + '/')), list: async uri => {
    const entries = new Map(); for (const file of files.keys()) if (file.startsWith(uri)) { const rest = file.slice(uri.length), name = rest.split('/')[0]; if (name) entries.set(name, { name, directory: rest.includes('/') }); } return [...entries.values()];
  } };
  const engine = new ExternalTypes(host), sym = { uri: 'file:///gem5/src/mem/ruby/protocol/cache.sm', kind: 'structure', name: 'MessageBuffer', attributes: { external: 'yes' } };
  const result = await engine.inspect(sym); assert.equal(result.status, 'resolved'); assert.equal(result.locations.length, 1); assert.match(result.locations[0].uri, /network\/MessageBuffer.hh$/);
  assert.equal((await engine.inspect({ ...sym, name: 'Unreachable' })).status, 'missing');
  assert.equal((await engine.inspect({ ...sym, uri: 'file:///elsewhere/cache.sm' })).status, 'unavailable');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceIndex } = require('../src/core/index');
const { Analysis } = require('../src/core/analysis');
const { diagnostics } = require('../src/core/diagnostics');
const { hints } = require('../src/core/hints');
const { lex, builtinNames, attributes } = require('../src/core/lexer');
const { printfDiagnostics } = require('../src/core/printf');
const { ExternalTypes } = require('../src/core/build-scope');
const { DebugFlags } = require('../src/core/debug-flags');

function fixture(text, files = {}) {
  const index = new WorkspaceIndex();
  for (const [name, value] of Object.entries({ 'cache.sm': text, ...files })) index.set('file:///p/' + name, value);
  const source = index.sources.get('file:///p/cache.sm'), a = new Analysis(index, source);
  return { index, source, a, token: (name, n = 0) => source.tokens.filter(t => t.text === name)[n], issues: () => diagnostics(index, source) };
}
const transitionIssues = s => s.issues().filter(i => i.code.startsWith('transition-'));

test('1.5 attributes and stallPort are highlighted, while port method names are ordinary identifiers', () => {
  const names = ['rsc_stall_handler', 'prot_stall_handler', 'wake_up', 'return_by_ref', 'return_by_pointer', 'stallPort'];
  for (const name of names) {
    assert.equal(lex(name).tokens[0].kind, 'keyword');
    assert.equal(lex(name + '_value').tokens[0].kind, 'identifier');
  }
  for (const name of names.slice(0, -1)) assert(attributes.includes(name));
  const grammar = require('../syntaxes/slicc.tmLanguage.json');
  const builtins = new RegExp(grammar.patterns.find(p => p.name === 'support.function.builtin.slicc').match);
  const attrs = new RegExp(grammar.patterns.find(p => p.name === 'entity.other.attribute-name.slicc').match);
  assert(builtins.test('stallPort')); assert(attrs.test('wake_up ='));
  for (const name of ['isReady', 'dequeue']) {
    assert.equal(lex(name).tokens[0].kind, 'identifier'); assert(!builtinNames.has(name)); assert(!builtins.test(name));
  }
});

test('stallPort has a void result in assignments and nested calls', () => {
  const s = fixture('void take(int n); void f() { stallPort(1); int n := stallPort(1); take(stallPort(1)); }');
  assert.equal(s.issues().filter(i => i.code === 'function-result').length, 2);
  assert.equal(s.issues().filter(i => i.code === 'call').length, 0);
});

for (const separator of [' ', '\n', ',', ';', ',\n', ';\n']) {
  test(`transition lists accept ${JSON.stringify(separator)}, optional trailing separators and wildcard next states`, () => {
    const s = fixture(`machine(MachineType:Cache) { action(a, "a") {} transition({I${separator}S;}, {Load${separator}Store,}, *) { a${separator}missing; } transition(S, Store) {} }`);
    assert.deepEqual(s.source.issues, []);
    assert.deepEqual(s.source.transitions[0].states, ['I', 'S']);
    assert.deepEqual(transitionIssues(s).map(i => i.code), ['transition-action', 'transition-duplicate']);
    assert.equal(s.source.text.slice(transitionIssues(s)[0].start, transitionIssues(s)[0].end), 'missing');
  });
}

test('single empty and semicolon-free transition blocks are actions, and two blocks separate resources', () => {
  const s = fixture('machine(MachineType:Cache) { action(a, "a") {} transition(I, Load) { a missing } transition(S, Load) { ResourceA, ResourceB } { a } transition(M, Load) {} }');
  assert.deepEqual(transitionIssues(s).map(i => s.source.text.slice(i.start, i.end)), ['missing']);
  for (const name of ['ResourceA', 'ResourceB']) assert.equal(s.source.roles.get(s.token(name).index), 'resource');
  assert.equal(s.a.resolve(s.token('a', 2).index)[0].kind, 'action');
  assert(s.source.transitions.every(t => t.complete));
});

for (const header of ['*, Load', 'I, *', 'I, Load, **', '{I,,S}, Load', '{;I}, Load', 'I, {Load;;Store}']) {
  test(`malformed transition header ${header} keeps syntax diagnostics and defers semantic checks`, () => {
    const s = fixture(`transition(${header}) { missing; }`);
    assert(s.source.issues.some(i => i.code === 'syntax')); assert.deepEqual(transitionIssues(s), []);
  });
}

test('malformed action blocks recover later declarations and preserve forward and reverse navigation', () => {
  const s = fixture('machine(MachineType:Cache) { action(broken, "b") { assert(true) { int x; } action(good, "g") {} transition(I, Load) { good } transition(S, Store, *) { good; } }');
  assert(s.source.issues.some(i => i.code === 'syntax'));
  assert.deepEqual(s.source.symbols.filter(x => x.kind === 'action').map(x => x.name), ['broken', 'good']);
  assert.equal(s.source.transitions.length, 2);
  const good = s.source.symbols.find(x => x.name === 'good');
  assert.equal(good.scope.kind, 'machine'); assert.equal(s.a.related(good).length, 2);
  for (const token of s.source.tokens.filter(t => t.text === 'good').slice(1)) assert.equal(s.a.resolve(token.index)[0].id, good.id);
  assert.deepEqual(s.issues().map(i => i.code), ['syntax']);
});

test('enumeration defaults use the declared enum, preserving underscores and reverse references', () => {
  const s = fixture('enumeration(E_Name, default=E_Name_Member_Name) { Member_Name; Other; } enumeration(Unrelated) { E_Name_Member_Name; } structure(Box) { E_Name value, default=E_Name_Member_Name; E_Name direct, default=Member_Name; }');
  const expected = s.source.symbols.find(x => x.name === 'Member_Name');
  for (const i of s.source.defaults.keys()) assert.equal(s.a.resolve(i)[0].id, expected.id);
  assert.equal(s.a.references(expected).length, 3);
  assert.deepEqual(s.issues(), []);
});

test('enum defaults do not fall back to unrelated constants or treat strings as references', () => {
  const s = fixture('enumeration(E) { A; } enumeration(Other) { Missing; } structure(Box) { E x, default=Missing; E y, default="E_A"; }');
  assert.equal(s.source.defaults.size, 1);
  const [i] = s.source.defaults.keys(); assert.deepEqual(s.a.resolve(i), []);
  assert(s.issues().some(i => i.code === 'unresolved' && /Missing/.test(i.message)));
});

test('explicit variables take priority over enum aliases and generated helpers', () => {
  const s = fixture('enumeration(E) { A; } int E_A; structure(Box) { E x, default=E_A; } int E_to_string; void f() { E_to_string(1); }');
  assert.equal(s.a.resolve(s.token('E_A', 1).index)[0].kind, 'field');
  const call = s.token('E_to_string', 1); assert.equal(s.a.resolve(call.index)[0].kind, 'field'); assert.equal(s.a.generated(call.index), undefined);
});

test('enum defaults defer duplicate types, duplicate members, shared machine owners and unfinished declarations', () => {
  for (const text of [
    'enumeration(E) { A; } enumeration(E) { A; } E x, default=E_A;',
    'enumeration(E) { A; A; } E x, default=E_A;',
    'E x, default=E_A; enumeration(E) { A;'
  ]) {
    const s = fixture(text), [i] = s.source.defaults.keys(); assert.equal(s.a.enumDefault(i)?.deferred, true); assert.deepEqual(s.a.resolve(i), []);
  }
  const s = fixture('machine(MachineType:A) { include "shared.sm"; } machine(MachineType:B) { include "shared.sm"; }', { 'shared.sm': 'enumeration(E) { A; } E x, default=E_A;' });
  const source = s.index.sources.get('file:///p/shared.sm'), a = new Analysis(s.index, source), [i] = source.defaults.keys(); assert.equal(a.enumDefault(i).deferred, true);
});

test('generated global and machine enum/state helpers resolve to their exact generating declarations', () => {
  const s = fixture('enumeration(Global) { A; } machine(MachineType:Cache) { enumeration(Local) { A; } state_declaration(State) { I; } void f() { Global_to_string(1); Cache_Local_to_string(1); Cache_State_to_string(1); Cache_State_to_permission(1); Local_to_string(1); Cache_Local_to_permission(1); Global_to_unknown(1); } }');
  for (const [name, expected] of [['Global_to_string', 'Global'], ['Cache_Local_to_string', 'Local'], ['Cache_State_to_string', 'State'], ['Cache_State_to_permission', 'State']]) {
    const i = s.token(name).index; assert.equal(s.a.generated(i).name, expected); assert.equal(s.a.resolve(i)[0].name, expected);
  }
  for (const name of ['Local_to_string', 'Cache_Local_to_permission', 'Global_to_unknown']) assert.equal(s.a.generated(s.token(name).index), undefined);
  const state = s.source.symbols.find(x => x.kind === 'state_declaration'); assert.equal(s.a.references(state).length, 2);
});

test('external and primitive machine enums use the generated unprefixed type identifier', () => {
  const s = fixture('machine(MachineType:Cache) { enumeration(E, external="yes", external_name="Native") { A; } enumeration(P, primitive="yes") { A; } void f() { Native_to_string(1); P_to_string(1); Cache_E_to_string(1); } }');
  assert.equal(s.a.resolve(s.token('Native_to_string').index)[0].name, 'E');
  assert.equal(s.a.resolve(s.token('P_to_string').index)[0].name, 'P');
  assert.equal(s.a.generated(s.token('Cache_E_to_string').index), undefined);
});

test('handwritten helpers keep function overload priority, even when arguments mismatch', () => {
  const s = fixture('enumeration(E) { A; } int E_to_string(bool n); void f() { E_to_string(1, 2); }');
  const i = s.token('E_to_string', 1).index; assert.equal(s.a.generated(i), undefined);
  assert.equal(s.a.call(i).allCandidates[0].kind, 'function');
});

test('generated helpers follow machine includes without adopting global or outside-machine includes', () => {
  const s = fixture('include "globals.sm"; machine(MachineType:Cache) { include "types.sm"; void f() { Cache_E_to_string(1); G_to_string(1); Cache_G_to_string(1); } }', { 'globals.sm': 'enumeration(G) { A; }', 'types.sm': 'enumeration(E) { A; }' });
  assert.equal(s.a.resolve(s.token('Cache_E_to_string').index)[0].name, 'E');
  assert.equal(s.a.resolve(s.token('G_to_string').index)[0].name, 'G');
  assert.equal(s.a.generated(s.token('Cache_G_to_string').index), undefined);
  assert.equal(s.index.machineContexts(s.index.sources.get('file:///p/globals.sm')).length, 0);
});

test('ambiguous and incomplete enum generators do not produce helper targets', () => {
  for (const text of ['enumeration(E) { A; } enumeration(E) { B; } void f() { E_to_string(1); }', 'void f() { E_to_string(1); } enumeration(E) { A;']) {
    const s = fixture(text); assert.equal(s.a.generated(s.token('E_to_string').index), undefined);
  }
});

const portTypes = 'structure(InPort) { bool isReady(Tick now); void dequeue(Tick now); int count(); } structure(OutPort) { void enqueueDeferredMessages(int value, Tick now); bool areNSlotsAvailable(int count, Tick now); } structure(Message) { void wrongMessageMethod(); } external_type(Tick);';
test('logical port receivers use fixed declaration-driven types for methods, hints and return values', () => {
  const s = fixture(portTypes + ' machine(MachineType:Cache) { in_port(input, Message, queue) {} out_port(output, Message, queue); void take(bool value); void f(Tick now) { input.isReady(now); input.dequeue(now); output.enqueueDeferredMessages(1, now); bool ready := input.count(); take(input.count()); input.wrongMessageMethod(); } }');
  for (const name of ['input', 'output']) {
    const i = s.source.tokens.find(t => t.text === name && s.source.tokens[t.index + 1]?.text === '.').index;
    assert.equal(s.a.infer(i, i + 1).type, name === 'input' ? 'InPort' : 'OutPort');
  }
  for (const name of ['isReady', 'dequeue', 'enqueueDeferredMessages']) {
    const i = s.token(name, 1).index, call = s.a.call(i);
    assert.equal(call.selected.length, 1); assert.equal(call.selected[0].name, name);
    assert.equal(s.a.resolve(i)[0].id, call.selected[0].id);
    assert(s.a.references(call.selected[0]).some(ref => ref.token.index === i));
  }
  assert.equal(s.issues().filter(i => i.code === 'function-result').length, 2);
  assert.deepEqual(s.issues().filter(i => i.code === 'member').map(i => s.source.text.slice(i.start, i.end)), ['wrongMessageMethod']);
  assert(hints(s.index, s.source).some(h => h.label === 'value:'));
});

test('ordinary free and user-defined isReady/dequeue resolve and infer their declared result types', () => {
  const s = fixture('int isReady(); int dequeue(); structure(T) { int isReady(); int dequeue(); } T value; void f() { bool b := isReady(); bool c := value.isReady(); bool d := dequeue(); bool e := value.dequeue(); }');
  assert.equal(s.issues().filter(i => i.code === 'function-result').length, 4);
  const missing = fixture('void f() { isReady(); dequeue(); }');
  assert.deepEqual(missing.issues().filter(i => i.code === 'call').map(i => missing.source.text.slice(i.start, i.end)), ['isReady', 'dequeue']);
});

test('explicit parameters, preceding locals and fields shadow logical ports', () => {
  const s = fixture(portTypes + ' structure(T) { int Own; } machine(MachineType:Cache) { in_port(input, Message, queue) {} out_port(output, Message, queue); T output; void f(T input) { input.Own; output.Own; } void g() { T input; input.Own; } }');
  for (const token of s.source.tokens.filter(t => t.text === 'Own').slice(1)) assert.equal(s.a.resolve(token.index)[0].name, 'Own');
  assert.equal(s.issues().filter(i => i.code === 'member').length, 0);
});

test('duplicate ports or receiver types defer member checks instead of choosing an arbitrary declaration', () => {
  for (const declarations of ['in_port(p, Message, q) {} out_port(p, Message, q);', 'in_port(p, Message, q) {} structure(InPort) { bool other(); }']) {
    const s = fixture(portTypes + ` machine(MachineType:Cache) { ${declarations} void f() { p.missing(); } }`);
    const dot = s.source.tokens.find(t => t.text === '.'), receiver = s.a.receiver(dot.index);
    assert(!s.a.members(receiver.type, receiver.at, receiver.source).complete);
    assert.equal(s.issues().filter(i => i.code === 'member').length, 0);
  }
});

test('ports do not cross machines or hide an unrelated machine free function', () => {
  const s = fixture(portTypes + ' machine(MachineType:A) { int input(); void f() { input(); } } machine(MachineType:B) { in_port(input, Message, q) {} }');
  const i = s.token('input', 1).index; assert.equal(s.a.resolve(i)[0].kind, 'function');
  assert.equal(s.a.port('input', s.token('input', 1).start).known, false);
  const shared = fixture(portTypes + ' machine(MachineType:A) { in_port(p, Message, q) {} include "shared.sm"; } machine(MachineType:B) { in_port(p, Message, q) {} include "shared.sm"; }', { 'shared.sm': 'void f() { p.isReady(1); }' });
  const file = shared.index.sources.get('file:///p/shared.sm'), a = new Analysis(shared.index, file), p = file.tokens.find(t => t.text === 'p'); assert.deepEqual(a.resolve(p.index), []);
});

function memory(values, roots = []) {
  const files = new Map(Object.entries(values));
  const host = {
    projectRoots: () => roots,
    read: async uri => files.get(uri),
    exists: async uri => files.has(uri) || [...files.keys()].some(k => k.startsWith(uri.replace(/\/?$/, '/'))),
    list: async uri => {
      if (![...files.keys()].some(k => k.startsWith(uri))) return undefined;
      const entries = new Map();
      for (const key of files.keys()) if (key.startsWith(uri)) { const rest = key.slice(uri.length), name = rest.split('/')[0]; if (name) entries.set(name, { name, directory: rest.includes('/') }); }
      return [...entries.values()];
    }
  };
  return { files, host };
}

test('debug flags scan non-Ruby scripts throughout the gem5 checkout without a Kconfig dependency', async () => {
  const { files, host } = memory({
    'file:///gem5/SConstruct': '', 'file:///gem5/src/mem/ruby/Kconfig': 'source "missing"',
    'file:///gem5/src/mem/ruby/SConscript': 'DebugFlag("Ruby")', 'file:///gem5/src/mem/ruby/protocol/a.sm': '',
    'file:///gem5/src/mem/SConscript': 'DebugFlag("HtmMem")', 'file:///gem5/ext/example/SConsopts': 'CompoundFlag("All", [])',
    'file:///other/SConscript': 'DebugFlag("Unrelated")', 'file:///gem5/build/SConscript': 'DebugFlag("Excluded")'
  });
  const flags = new DebugFlags(new ExternalTypes(host)), uri = 'file:///gem5/src/mem/ruby/protocol/a.sm';
  const first = await flags.snapshot(uri); assert.equal(first.complete, true);
  assert.deepEqual(first.flags.map(f => f.name).sort(), ['All', 'HtmMem', 'Ruby']);
  assert.equal(await flags.snapshot(uri), first);
  files.set('file:///gem5/src/mem/SConscript', 'DebugFlag("Changed")'); flags.invalidate();
  assert((await flags.snapshot(uri)).flags.some(f => f.name === 'Changed'));
});

test('ordinary projects discover flags without a Ruby root, including multiple workspace folders', async () => {
  const { host } = memory({ 'file:///project/SConscript': 'DebugFlag("Local")', 'file:///extra/sub/SConscript': 'DebugFlag("Extra")' }, ['file:///project/', 'file:///extra/']);
  const result = await new DebugFlags(new ExternalTypes(host)).snapshot('file:///project/file.sm');
  assert.equal(result.complete, true); assert.deepEqual(result.flags.map(f => f.name).sort(), ['Extra', 'Local']);
});

test('unavailable or incomplete debug discovery preserves known completions and defers unknown errors', async () => {
  const { host } = memory({ 'file:///p/ruby/Kconfig': '', 'file:///p/ruby/SConscript': 'DebugFlag("Ruby")', 'file:///p/ruby/protocol/a.sm': '' });
  const flags = await new DebugFlags(new ExternalTypes(host)).snapshot('file:///p/ruby/protocol/a.sm');
  assert.equal(flags.complete, false); assert.equal(flags.flags[0].name, 'Ruby');
  const s = fixture('void f() { DPRINTF(Unknown, "ok"); }'); assert.deepEqual(printfDiagnostics(s.source, flags), []);
  host.projectRoots = () => ['file:///p/'];
  const list = host.list; host.list = async uri => uri.endsWith('/unreadable/') ? undefined : [...await list(uri) ?? [], ...(uri === 'file:///p/' ? [{ name: 'unreadable', directory: true }] : [])];
  assert.equal((await new DebugFlags(new ExternalTypes(host)).snapshot('file:///p/ruby/protocol/a.sm')).complete, false);
});

test('only printf count mismatches become warnings; missing flags and format strings stay errors', () => {
  const s = fixture('void f() { DPRINTF(Ruby, "%d"); DPRINTFN("%*.*f", 1); DPRINTF(Missing, "ok"); DPRINTF(); DPRINTFN(); APPEND_TRANSITION_COMMENT("%d"); }');
  const result = printfDiagnostics(s.source, { complete: true, flags: [{ name: 'Ruby' }] });
  assert.deepEqual(result.map(i => [s.source.text.slice(i.start, i.end), i.severity]), [['"%d"', 'warning'], ['"%*.*f"', 'warning'], ['Missing', 'error'], ['DPRINTF', 'error'], ['DPRINTFN', 'error']]);
});

const ruby = 'file:///gem5/src/mem/ruby/';
function externalFixture(machine, global = '', cpp = '') {
  const { files, host } = memory({
    [ruby + 'Kconfig']: 'rsource "protocol/Kconfig"',
    [ruby + 'protocol/Kconfig']: 'config RUBY_PROTOCOL_CHI\n bool " CHI   Protocol "\nconfig RUBY_PROTOCOL_Other\n bool "Other"',
    [ruby + 'SConscript']: 'MakeInclude("Types.hh")',
    [ruby + 'Types.hh']: 'namespace gem5::ruby { class Shared {}; namespace CHI { class Scoped {}; class Shared {}; class OnlyCHI {}; } namespace Other { class Scoped {}; class OtherOnly {}; } }' + cpp,
    [ruby + 'protocol/chi.slicc']: 'protocol "CHI Protocol"; include "cache.sm"; include "global.sm";',
    [ruby + 'protocol/cache.sm']: `machine(MachineType:Cache) { ${machine} }`,
    [ruby + 'protocol/global.sm']: global
  });
  const index = new WorkspaceIndex();
  for (const [uri, text] of files) if (/\.(sm|slicc)$/.test(uri)) index.set(uri, text);
  const engine = new ExternalTypes(host, index);
  const sym = name => [...index.sources.values()].flatMap(s => s.symbols).find(s => s.name === name);
  return { files, host, index, engine, sym };
}

test('external machine types prefer their unique protocol namespace, then shared Ruby', async () => {
  const s = externalFixture('structure(Scoped, external="yes") {} structure(Shared, external="yes") {}');
  for (const name of ['Scoped', 'Shared']) {
    const info = await s.engine.inspect(s.sym(name)); assert.equal(info.status, 'resolved'); assert.equal(info.locations[0].qualifiedName, 'gem5::ruby::CHI::' + name);
  }
});

test('non-machine external types prefer shared Ruby before a uniquely configured protocol', async () => {
  const s = externalFixture('', 'structure(Shared, external="yes") {} structure(OnlyCHI, external="yes") {}');
  assert.equal((await s.engine.inspect(s.sym('Shared'))).locations[0].qualifiedName, 'gem5::ruby::Shared');
  assert.equal((await s.engine.inspect(s.sym('OnlyCHI'))).locations[0].qualifiedName, 'gem5::ruby::CHI::OnlyCHI');
});

test('external protocol resolution never borrows a different protocol and keeps qualified overrides exact', async () => {
  const s = externalFixture('structure(OtherOnly, external="yes") {} structure(Exact, external="yes", external_name="gem5::ruby::Other::Scoped") {}');
  assert.equal((await s.engine.inspect(s.sym('OtherOnly'))).status, 'missing');
  assert.equal((await s.engine.inspect(s.sym('Exact'))).locations[0].qualifiedName, 'gem5::ruby::Other::Scoped');
});

test('unknown and conflicting protocol owners warn after shared fallback misses', async () => {
  for (const text of ['protocol "Unknown"; include "cache.sm";', 'protocol "CHI"; protocol "Other"; include "cache.sm";']) {
    const s = externalFixture('structure(Scoped, external="yes") {} structure(Shared, external="yes") {} structure(Template, external="yes", external_name="Missing<gem5::Addr>") {}');
    s.files.set(ruby + 'protocol/chi.slicc', text);
    const missing = await s.engine.inspect(s.sym('Scoped')); assert.equal(missing.status, 'unavailable'); assert.match(missing.reason, /unique Kconfig protocol/);
    assert.equal((await s.engine.inspect(s.sym('Template'))).status, 'unavailable');
    assert.equal((await s.engine.inspect(s.sym('Shared'))).locations[0].qualifiedName, 'gem5::ruby::Shared');
  }
});

test('only literal includes inside a machine propagate machine ownership transitively', async () => {
  const s = externalFixture('include "owned.sm";');
  s.files.set(ruby + 'protocol/owned.sm', 'include "nested.sm";');
  s.files.set(ruby + 'protocol/nested.sm', 'structure(Owned, external="yes", external_name="Shared") {}');
  s.files.set(ruby + 'protocol/outside.sm', 'structure(Outside, external="yes", external_name="Shared") {}');
  const root = 'include "outside.sm"; machine(MachineType:Cache) { include "owned.sm"; }';
  s.files.set(ruby + 'protocol/cache.sm', root);
  for (const name of ['cache', 'owned', 'nested', 'outside']) s.index.set(ruby + `protocol/${name}.sm`, s.files.get(ruby + `protocol/${name}.sm`));
  assert.equal((await s.engine.inspect(s.sym('Owned'))).locations[0].qualifiedName, 'gem5::ruby::CHI::Shared');
  assert.equal((await s.engine.inspect(s.sym('Outside'))).locations[0].qualifiedName, 'gem5::ruby::Shared');
  s.files.set(ruby + 'protocol/cache.sm', 'include "owned.sm"; machine(MachineType:Cache) {}');
  s.engine.protocols.invalidate();
  assert.equal((await s.engine.inspect(s.sym('Owned'))).locations[0].qualifiedName, 'gem5::ruby::Shared');
});

test('protocol literal and include edits refresh ownership while reusing the C++ source snapshot', async () => {
  const s = externalFixture('structure(Scoped, external="yes") {}');
  const first = await s.engine.inspect(s.sym('Scoped')); assert.equal(first.locations[0].qualifiedName, 'gem5::ruby::CHI::Scoped');
  const snapshot = s.engine.snapshots.get(ruby);
  s.files.set(ruby + 'protocol/chi.slicc', 'protocol "Other"; include "cache.sm";');
  s.engine.protocols.invalidate();
  assert.equal((await s.engine.inspect(s.sym('Scoped'))).locations[0].qualifiedName, 'gem5::ruby::Other::Scoped');
  assert.equal(s.engine.snapshots.get(ruby), snapshot);
  s.files.set(ruby + 'protocol/chi.slicc', 'protocol "Other";'); s.engine.protocols.invalidate();
  assert.equal((await s.engine.inspect(s.sym('Scoped'))).status, 'unavailable'); assert.equal(s.engine.snapshots.get(ruby), snapshot);
});

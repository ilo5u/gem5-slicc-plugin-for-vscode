'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceIndex } = require('../src/core/index');
const { Analysis } = require('../src/core/analysis');
const { diagnostics } = require('../src/core/diagnostics');
const { hints } = require('../src/core/hints');
const { lex, keywords, outputBuiltins } = require('../src/core/lexer');
const { argumentCount, printfDiagnostics, debugFlagPosition } = require('../src/core/printf');
const { ExternalTypes } = require('../src/core/build-scope');
const { DebugFlags, parseFlags } = require('../src/core/debug-flags');

function fixture(text, files = {}) {
  const index = new WorkspaceIndex();
  for (const [name, body] of Object.entries({ 'cache.sm': text, ...files })) index.set('file:///p/' + name, body);
  const source = index.sources.get('file:///p/cache.sm'), a = new Analysis(index, source);
  return { index, source, a, issues: options => diagnostics(index, source, options), token: (name, n = 0) => source.tokens.filter(t => t.text === name)[n] };
}
const machine = body => `structure(AbstractCacheEntry) {} machine(MachineType:Cache) { ${body} }`;

test('1.4 builtins and attributes have keyword tokens without matching prefixes', () => {
  const tokens = lex('DPRINTF DPRINTFN APPEND_TRANSITION_COMMENT block_on format DPRINTFN_extra format_value "format" // block_on').tokens;
  assert.ok(tokens.slice(0, 5).every(t => t.kind === 'keyword'));
  assert.ok(tokens.slice(5, 7).every(t => t.kind === 'identifier'));
  assert.equal(tokens[7].kind, 'string'); assert.equal(outputBuiltins.size, 3);
});

test('cache_entry selects a renamed primary implementing AbstractCacheEntry', () => {
  const s = fixture(machine('structure(CacheEntry, interface="AbstractCacheEntry") { int Value; } structure(DirEntry, interface="AbstractCacheEntry", main="FaLsE") { int Directory; } action(a, "a") { cache_entry.Value; }'));
  const implicit = s.a.implicit('cache_entry', s.token('cache_entry').start);
  assert.equal(implicit.type, 'CacheEntry'); assert.equal(implicit.typeTarget.name, 'CacheEntry');
  assert.deepEqual(s.a.members(implicit.type, implicit.nameStart).symbols.map(s => s.name), ['Value']);
  assert.deepEqual(hints(s.index, s.source).filter(h => h.kind === 'type').map(h => h.label), [': CacheEntry']);
  assert.equal(s.issues().length, 0);
});

for (const [name, types] of Object.entries({ missing: 'structure(Entry) {}', disabled: 'structure(Entry, interface="AbstractCacheEntry", main="false") {}', ambiguous: 'structure(A, interface="AbstractCacheEntry") {} structure(B, interface="AbstractCacheEntry") {}' })) {
  test(`cache_entry defers ${name} defaults without a literal Entry fallback`, () => {
    const s = fixture(machine(`${types} action(a, "a") { cache_entry.Unknown; }`));
    assert.equal(s.a.implicit('cache_entry', s.token('cache_entry').start).type, undefined);
    assert.equal(s.issues().filter(i => i.code === 'member').length, 0);
    assert.equal(hints(s.index, s.source).length, 0);
  });
}

test('cache_entry selection follows machine includes, cache invalidation and explicit shadowing', () => {
  const s = fixture('machine(MachineType:Cache) { include "types.sm"; include "actions.sm"; action(local, "l") { Other cache_entry; cache_entry.Local; } }', {
    'types.sm': 'structure(AbstractCacheEntry) {} structure(CacheEntry, interface="AbstractCacheEntry") { int Value; } structure(Other) { int Local; }',
    'actions.sm': 'action(a, "a") { cache_entry.Value; }',
    'other.sm': 'machine(MachineType:Other) { structure(Wrong, interface="AbstractCacheEntry") {} }'
  });
  const other = s.index.sources.get('file:///p/actions.sm'), a = new Analysis(s.index, other);
  assert.equal(a.implicit('cache_entry', other.tokens.find(t => t.text === 'cache_entry').start).type, 'CacheEntry');
  assert.equal(s.a.resolve(s.token('Local').index)[0].name, 'Local');
  s.index.set('file:///p/types.sm', 'structure(Renamed, interface="AbstractCacheEntry") {}');
  const updated = new Analysis(s.index, other); assert.equal(updated.implicit('cache_entry', other.tokens.find(t => t.text === 'cache_entry').start).type, 'Renamed');
});

test('cache_entry does not infer across ambiguous shared-machine owners or action boundaries', () => {
  const s = fixture('machine(MachineType:A) { include "shared.sm"; } machine(MachineType:B) { include "shared.sm"; }', { 'shared.sm': 'structure(CacheEntry, interface="AbstractCacheEntry") {} action(a, "a") { cache_entry.X; } void f() { cache_entry; }' });
  const source = s.index.sources.get('file:///p/shared.sm'), a = new Analysis(s.index, source), uses = source.tokens.filter(t => t.text === 'cache_entry');
  assert.equal(a.implicit('cache_entry', uses[0].start).type, undefined); assert.equal(a.implicit('cache_entry', uses[1].start), undefined);
});

for (const [format, expected] of [['plain %%', 0], ['%d %s', 2], ['%*.*f', 3], ['%08.3lld %zu %b', 3], ['%2$d', undefined], ['%q', undefined], ['%', undefined], ['%*', undefined]]) {
  test(`printf counts ${JSON.stringify(format)} conservatively`, () => assert.equal(argumentCount(format), expected));
}

test('printf respects nested commas, adjacent strings and the no-flag DPRINTFN form', () => {
  const s = fixture('int f(int a, int b); void test() { DPRINTF(Ruby, "%d" " %*.*f %%", f(1, 2), 4, 2, 1.0); DPRINTFN("%d", f(1, 2)); }');
  assert.deepEqual(printfDiagnostics(s.source), []);
});

test('printf reports missing flags, unknown flags, missing formats and count errors with precise ranges', () => {
  const s = fixture('void f() { DPRINTF("%d", 1); DPRINTF(Missing, "%d"); DPRINTFN(); DPRINTFN("%*.*f", 1); }');
  const issues = printfDiagnostics(s.source, { complete: true, flags: [{ name: 'Ruby' }] });
  assert.equal(issues.length, 5);
  assert.deepEqual(issues.map(i => s.source.text.slice(i.start, i.end)), ['DPRINTF', 'Missing', '"%d"', 'DPRINTFN', '"%*.*f"']);
});

test('printf defers unavailable flags, dynamic formats, unsupported escapes and incomplete calls', () => {
  for (const text of ['DPRINTF(Unknown, fmt, 1);', 'DPRINTFN("%2$d", 1);', 'DPRINTFN("\\x25d", 1);', 'DPRINTFN("%d",);', 'DPRINTFN("%d",']) {
    const s = fixture(`void f() { ${text} }`); assert.deepEqual(printfDiagnostics(s.source, { complete: false, flags: [] }), []);
  }
});

test('debug flag completion applies only to DPRINTF first arguments, including empty calls', () => {
  for (const [text, expected] of [['DPRINTF(', true], ['DPRINTF( Ru', true], ['DPRINTFN(', false], ['DPRINTF(Ruby, ', false], ['x.DPRINTF(', false], ['DPRINTF(x + ', false]]) {
    const s = fixture(text); assert.equal(debugFlagPosition(s.source, text.length), expected, text);
  }
});

test('output builtins return void in assignments and nested function arguments', () => {
  const s = fixture('void take(int n); void f() { int n := DPRINTFN("hi"); take(APPEND_TRANSITION_COMMENT("x")); }');
  const issues = s.issues().filter(i => i.code === 'function-result'); assert.equal(issues.length, 2); assert.ok(issues.every(i => /Void/.test(i.message)));
});

test('debug flag scanner ignores comments, strings and docstrings and tracks computed declarations', () => {
  const result = parseFlags('file:///SConscript', '# DebugFlag("Fake")\n"DebugFlag(\'AlsoFake\')"\n"""DebugFlag("DocFake")"""\nDebugFlag("Ruby")\nCompoundFlag("All", ["Ruby"])\nDebugFlag(prefix + "Other")');
  assert.deepEqual(result.flags.map(f => f.name), ['Ruby', 'All']); assert.equal(result.complete, false);
});

function memoryHost(values) {
  const files = new Map(Object.entries(values));
  return { files, host: {
    read: async uri => files.get(uri),
    exists: async uri => files.has(uri) || [...files.keys()].some(k => k.startsWith(uri.replace(/\/?$/, '/'))),
    list: async uri => { const entries = new Map(); for (const key of files.keys()) if (key.startsWith(uri)) { const rest = key.slice(uri.length), name = rest.split('/')[0]; if (name) entries.set(name, { name, directory: rest.includes('/') }); } return [...entries.values()]; }
  } };
}

test('debug flags scan the current project, isolate checkouts and invalidate on edits', async () => {
  const { files, host } = memoryHost({
    'file:///p/ruby/Kconfig': 'rsource "../extra/Kconfig"\norsource "optional/Kconfig"', 'file:///p/ruby/SConscript': 'DebugFlag("Ruby")', 'file:///p/ruby/protocol/a.sm': '',
    'file:///p/extra/Kconfig': '', 'file:///p/extra/SConscript': 'CompoundFlag("Extra", ["Ruby"])',
    'file:///elsewhere/ruby/Kconfig': '', 'file:///elsewhere/ruby/SConscript': 'DebugFlag("Unrelated")'
  });
  host.projectRoots = () => ['file:///p/'];
  const flags = new DebugFlags(new ExternalTypes(host));
  const snapshot = await flags.snapshot('file:///p/ruby/protocol/a.sm'); assert.equal(snapshot.complete, true); assert.deepEqual(snapshot.flags.map(f => f.name), ['Extra', 'Ruby']);
  assert.equal(await flags.snapshot('file:///p/ruby/protocol/a.sm'), snapshot);
  files.set('file:///p/ruby/SConscript', 'DebugFlag("Changed")'); flags.invalidate();
  assert.ok((await flags.snapshot('file:///p/ruby/protocol/a.sm')).flags.some(f => f.name === 'Changed'));
});

test('project-wide debug flags are independent of missing Kconfig sources', async () => {
  const { host } = memoryHost({ 'file:///p/ruby/Kconfig': 'rsource "missing/Kconfig"', 'file:///p/ruby/SConscript': 'DebugFlag("Ruby")', 'file:///p/ruby/protocol/a.sm': '' });
  host.projectRoots = () => ['file:///p/'];
  const flags = await new DebugFlags(new ExternalTypes(host)).snapshot('file:///p/ruby/protocol/a.sm');
  assert.equal(flags.complete, true); assert.equal(flags.flags[0].name, 'Ruby');
});

test('transitions report unknown actions and later overlapping expanded state/event sets once', () => {
  const s = fixture('machine(MachineType:Cache) { action(a, "a") {} transition({I,S}, {Load,Store}) { a; } transition(S, Load) { Missing; } }');
  const issues = s.issues().filter(i => i.code.startsWith('transition-'));
  assert.deepEqual(issues.map(i => i.code), ['transition-action', 'transition-duplicate']);
  assert.equal(s.source.text.slice(issues[0].start, issues[0].end), 'Missing'); assert.equal(s.source.text.slice(issues[1].start, issues[1].end), 'transition(S, Load)');
  assert.deepEqual(s.issues().filter(i => i.code.startsWith('transition-')), issues);
});

test('transition diagnostics follow include position rather than file name or load order', () => {
  const s = fixture('machine(MachineType:Cache) { include "z.sm"; include "a.sm"; }', { 'a.sm': 'transition(I, Load) { a; }', 'z.sm': 'action(a, "a") {} transition(I, Load) { a; }' });
  const later = s.index.sources.get('file:///p/a.sm'), first = s.index.sources.get('file:///p/z.sm');
  assert.equal(diagnostics(s.index, later).filter(i => i.code === 'transition-duplicate').length, 1);
  assert.equal(diagnostics(s.index, first).filter(i => i.code === 'transition-duplicate').length, 0);
  s.index.set('file:///p/z.sm', 'action(a, "a") {} transition(S, Load) { a; }');
  assert.equal(diagnostics(s.index, later).filter(i => i.code === 'transition-duplicate').length, 0);
});

test('transition diagnostics keep machines separate and defer cyclic, missing, ambiguous and malformed scopes', () => {
  for (const [body, files] of [
    ['include "missing.sm"; transition(I, Load) { missing; }', {}],
    ['include "shared.sm";', { 'shared.sm': 'include "cache.sm"; transition(I, Load) { missing; }' }],
    ['transition(I, Load) { missing + extra; }', {}]
  ]) { const s = fixture(`machine(MachineType:Cache) { ${body} }`, files); assert.equal(s.issues().filter(i => i.code.startsWith('transition-')).length, 0); }
  const s = fixture('machine(MachineType:A) { action(a, "a") {} transition(I, Load) { a; } } machine(MachineType:B) { transition(I, Load) { a; } }');
  assert.equal(s.issues().filter(i => i.code === 'transition-action').length, 1); assert.equal(s.issues().filter(i => i.code === 'transition-duplicate').length, 0);
  const shared = fixture('machine(MachineType:A) { include "s.sm"; } machine(MachineType:B) { include "s.sm"; }', { 's.sm': 'transition(I, Load) { missing; }' });
  assert.equal(diagnostics(shared.index, shared.index.sources.get('file:///p/s.sm')).filter(i => i.code.startsWith('transition-')).length, 0);
});

test('call diagnostics report missing names and support scoped interface methods', () => {
  const s = fixture('structure(Base) { void good(int n); } structure(Child, interface="Base") {} void f() { missing(); Child::bad(); Child::good(true, 1); }');
  assert.deepEqual(s.issues().filter(i => i.code === 'call').map(i => s.source.text.slice(i.start, i.end)), ['missing', 'bad']);
});

test('call diagnostics defer shadowing, constructors, unknown owners, wrong arities and incomplete contexts', () => {
  for (const text of [
    'structure(T) {} void good(int n); int callable; void f() { T(); int(1); good(true, 2); callable(); Unknown::bad(); }',
    'structure(T, interface="Missing") {} void f() { T::bad(); }',
    'include "missing.sm"; void f() { bad(); }',
    'void f() { bad(1,); }'
  ]) assert.equal(fixture(text).issues().filter(i => i.code === 'call').length, 0, text);
});

test('call names from unrelated machines do not suppress missing visible function errors', () => {
  const s = fixture('machine(MachineType:A) { void f() { hidden(); } } machine(MachineType:B) { void hidden(); }');
  assert.equal(s.issues().filter(i => i.code === 'call').length, 1);
});

test('scoped inherited and namespace-qualified methods share call resolution and name diagnostics', () => {
  const s = fixture('structure(Base) { int get(int value); } structure(Child, interface="Base") {} external_type(pkg::Type) { int get(int value); } external_type(Empty); void f() { int n := Child::get(1); int p := pkg::Type::get(2); Empty::missing(); }');
  for (const n of [2, 3]) assert.equal(s.a.call(s.token('get', n).index).selected[0].type, 'int');
  assert.deepEqual(s.issues().filter(i => i.code === 'call').map(i => s.source.text.slice(i.start, i.end)), ['missing']);
});

test('desc documentation uses only the selected declaration and preserves escaped content', () => {
  const s = fixture('structure(T, desc="Parent") { int Own, desc="<b>field</b>\\nsecond line"; int NoDescription; } T t; void f() { t.Own; t.NoDescription; }');
  const own = s.a.resolve(s.token('Own', 1).index)[0], blank = s.a.resolve(s.token('NoDescription', 1).index)[0];
  assert.equal(s.a.description(own), '<b>field</b>\nsecond line'); assert.equal(s.a.description(blank), undefined);
});

test('desc fallback matches prototypes and definitions without borrowing overload or owner documentation', () => {
  const s = fixture('int get(int n), desc="The integer overload"; int get(int n) { return n; } bool get(bool n), desc="Other"; void f() { get(1); }');
  const definition = s.source.symbols.find(x => x.kind === 'function' && x.hasBody && x.name === 'get');
  assert.equal(s.a.description(definition), 'The integer overload');
  const ambiguous = fixture('int get(int n), desc="First"; int get(int n), desc="Second"; int get(int n) { return n; }');
  assert.equal(ambiguous.a.description(ambiguous.source.symbols.find(x => x.hasBody)), undefined);
});

test('new diagnostics honor configuration and cancellation', () => {
  const s = fixture('state_declaration(State) { I; } enumeration(Event) { Load; } transition(I, Load) { unknown; } void f() { missing(); DPRINTFN("%d"); }');
  assert.equal(s.issues({ calls: false, printf: false, transitions: false }).length, 0);
  assert.deepEqual(diagnostics(s.index, s.source, {}, () => true), []);
});

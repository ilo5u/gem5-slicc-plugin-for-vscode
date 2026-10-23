'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceIndex } = require('../src/core/index');
const { Analysis } = require('../src/core/analysis');

function fixture(files) {
  const index = new WorkspaceIndex();
  for (const [name, text] of Object.entries(files)) index.set('file:///release160/' + name, text);
  const source = name => index.sources.get('file:///release160/' + name);
  const analysis = name => new Analysis(index, source(name));
  const field = (name, owner) => source(name).symbols.find(s => s.kind === 'field' && s.scope.kind === 'machine' && s.scope.owner.name === owner && s.name === 'directory');
  const resolve = (name, occurrence = 0) => analysis(name).resolve(source(name).tokens.filter(t => t.text === 'directory')[occurrence].index);
  return { index, source, analysis, field, resolve };
}

test('machine fields collect reads, writes and initializers with statement deduplication', () => {
  const s = fixture({ 'a.sm': 'machine(MachineType:A) { int directory; int mirror := directory; int read() { return directory; } action(a, "a") { directory := directory + 1; } }' });
  const field = s.field('a.sm', 'A'), a = s.analysis('a.sm');
  assert.equal(a.references(field).length, 4);
  assert.equal(a.references(field, true).length, 5);
  assert.deepEqual(a.related(field).map(ref => ref.source.text.slice(ref.start, ref.end).trim()), ['int mirror := directory;', 'return directory;', 'directory := directory + 1;']);
  for (const ref of a.related(field)) assert.equal(s.analysis('a.sm').resolve(ref.token.index)[0].id, field.id);
});

test('parameters and preceding locals shadow machine fields only within their lexical scopes', () => {
  const s = fixture({ 'a.sm': 'machine(MachineType:A) { int directory; void f(int directory) { directory := 4; } action(a, "a") { directory := 1; { int directory; directory := 2; } directory := 3; } }' });
  assert.equal(s.analysis('a.sm').references(s.field('a.sm', 'A')).length, 2);
  assert.equal(s.resolve('a.sm', 2)[0].kind, 'parameter');
  assert.equal(s.resolve('a.sm', 5)[0].kind, 'variable');
});

test('same-named structure members retain their receiver declaration identity', () => {
  const s = fixture({ 'a.sm': 'structure(Holder) { int directory; } machine(MachineType:A) { int directory; Holder h; action(a, "a") { directory := 1; h.directory := 2; } }' });
  const field = s.field('a.sm', 'A'), member = s.source('a.sm').symbols.find(x => x.name === 'directory' && x.scope.kind === 'structure');
  assert.equal(s.analysis('a.sm').references(field).length, 1);
  assert.equal(s.analysis('a.sm').references(member).length, 1);
  assert.equal(s.resolve('a.sm', 3)[0].id, member.id);
});

test('machine fields reach transitive includes and repeated cyclic includes terminate', () => {
  const s = fixture({
    'a.sm': 'machine(MachineType:A) { int directory; include "actions.sm"; include "actions.sm"; }',
    'actions.sm': 'include "functions.sm"; action(a, "a") { directory := 1; }',
    'functions.sm': 'include "actions.sm"; int read() { return directory; }'
  });
  const refs = s.analysis('a.sm').related(s.field('a.sm', 'A'));
  assert.equal(refs.length, 2);
  assert.deepEqual(new Set(refs.map(ref => ref.source.uri)), new Set([s.source('actions.sm').uri, s.source('functions.sm').uri]));
});

test('two machines in one file retain separate member and include ownership', () => {
  const s = fixture({
    'a.sm': 'machine(MachineType:A) { int directory; include "a-actions.sm"; action(a, "a") { directory := 1; } } machine(MachineType:B) { int directory; include "b-actions.sm"; action(b, "b") { directory := 2; } }',
    'a-actions.sm': 'void readA() { directory := 3; }',
    'b-actions.sm': 'void readB() { directory := 4; }'
  });
  for (const owner of ['A', 'B']) assert.equal(s.analysis('a.sm').related(s.field('a.sm', owner)).length, 2);
  assert.equal(s.resolve('a-actions.sm')[0].id, s.field('a.sm', 'A').id);
  assert.equal(s.resolve('b-actions.sm')[0].id, s.field('a.sm', 'B').id);
});

test('an ambiguous shared include never borrows the first machine member', () => {
  const s = fixture({
    'a.sm': 'machine(MachineType:A) { int directory; include "shared.sm"; action(a, "a") { directory := 1; } }',
    'b.sm': 'machine(MachineType:B) { int directory; include "shared.sm"; action(b, "b") { directory := 2; } }',
    'shared.sm': 'void read() { directory := 3; }'
  });
  assert.deepEqual(s.resolve('shared.sm'), []);
  assert(!s.analysis('shared.sm').visibleVariables(0).some(x => x.name === 'directory'));
  for (const [name, owner] of [['a.sm', 'A'], ['b.sm', 'B']]) assert.equal(s.analysis(name).related(s.field(name, owner)).length, 1);
});

test('ambiguous ownership defers a member even when only one machine declares its name', () => {
  const s = fixture({
    'a.sm': 'machine(MachineType:A) { int directory; include "shared.sm"; }',
    'b.sm': 'machine(MachineType:B) { include "shared.sm"; }',
    'shared.sm': 'void read() { directory := 1; }'
  });
  assert.deepEqual(s.resolve('shared.sm'), []);
  assert.equal(s.analysis('a.sm').references(s.field('a.sm', 'A')).length, 0);
});

test('lexical parameters still resolve within an ambiguously owned shared include', () => {
  const s = fixture({
    'a.sm': 'machine(MachineType:A) { int directory; include "shared.sm"; }',
    'b.sm': 'machine(MachineType:B) { int directory; include "shared.sm"; }',
    'shared.sm': 'void read(int directory) { directory := 1; }'
  });
  assert.equal(s.resolve('shared.sm', 1)[0].kind, 'parameter');
  assert.equal(s.analysis('a.sm').references(s.field('a.sm', 'A')).length, 0);
});

test('nested machines own their includes without propagating them to an outer include caller', () => {
  const s = fixture({
    'a.sm': 'machine(MachineType:A) { int directory; include "fragment.sm"; }',
    'fragment.sm': 'action(a, "a") { directory := 1; } machine(MachineType:B) { int directory; include "nested.sm"; }',
    'nested.sm': 'void readB() { directory := 2; }'
  });
  assert.deepEqual(s.index.machineContexts(s.source('nested.sm')).map(x => x.symbol.name), ['B']);
  assert.equal(s.resolve('nested.sm')[0].id, s.field('fragment.sm', 'B').id);
  assert.equal(s.analysis('a.sm').related(s.field('a.sm', 'A')).length, 1);
  assert.equal(s.analysis('fragment.sm').related(s.field('fragment.sm', 'B')).length, 1);
});

test('includes outside a machine and unrelated files do not acquire that machine member', () => {
  const s = fixture({
    'a.sm': 'include "outside.sm"; machine(MachineType:A) { int directory; action(a, "a") { directory := 1; } }',
    'outside.sm': 'void outside() { directory := 2; }',
    'unrelated.sm': 'void unrelated() { directory := 3; }'
  });
  assert.deepEqual(s.resolve('outside.sm'), []);
  assert.deepEqual(s.resolve('unrelated.sm'), []);
  assert.equal(s.analysis('a.sm').related(s.field('a.sm', 'A')).length, 1);
});

test('editing a machine include invalidates ownership and reverse usages', () => {
  const s = fixture({ 'a.sm': 'machine(MachineType:A) { int directory; include "actions.sm"; }', 'actions.sm': 'action(a, "a") { directory := 1; }' });
  assert.equal(s.analysis('a.sm').related(s.field('a.sm', 'A')).length, 1);
  s.index.set(s.source('a.sm').uri, 'include "actions.sm"; machine(MachineType:A) { int directory; }');
  assert.deepEqual(s.resolve('actions.sm'), []);
  assert.equal(s.analysis('a.sm').related(s.field('a.sm', 'A')).length, 0);
});

test('reverse machine-member navigation returns all 45 statements without truncation', () => {
  const calls = Array.from({ length: 45 }, () => 'consume(directory, directory);').join('\n');
  const s = fixture({ 'a.sm': `machine(MachineType:A) { int directory; void consume(int left, int right); action(a, "a") { ${calls} } }` });
  const field = s.field('a.sm', 'A'), a = s.analysis('a.sm');
  assert.equal(a.references(field).length, 90);
  assert.equal(a.related(field).length, 45);
  assert.equal(new Set(a.related(field).map(ref => ref.start)).size, 45);
});

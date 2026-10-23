'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { WorkspaceIndex } = require('../src/core/index');
const { Analysis } = require('../src/core/analysis');
const { diagnostics } = require('../src/core/diagnostics');
const { hints } = require('../src/core/hints');
const { ExternalTypes } = require('../src/core/build-scope');
const { DebugFlags } = require('../src/core/debug-flags');

async function main() {
  const reference = process.argv[2] || process.env.SLICC_REFERENCE_REPO;
  if (!reference) throw new Error('Usage: npm run test:corpus -- <path-to-CLion-plugin-or-gem5-repository> [git-ref]');
  const repo = path.resolve(reference), gitArgs = ['-c', `safe.directory=${repo.replace(/\\/g, '/')}`, '-C', repo];
  const ref = process.argv[3] || 'HEAD';
  const hash = spawnSync('git', [...gitArgs, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], { encoding: 'utf8', windowsHide: true });
  if (hash.status !== 0) throw new Error(hash.stderr || 'Cannot resolve the reference Git commit');
  const archive = spawnSync('git', [...gitArgs, 'archive', '--format=tar', hash.stdout.trim(), fs.existsSync(path.join(repo, 'ruby')) ? 'ruby' : 'src/mem/ruby'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (archive.status !== 0) throw new Error(archive.stderr?.toString() || 'Cannot read reference Git snapshot');
  const files = new Map(); let offset = 0, prefix = '';
  while (offset + 512 <= archive.stdout.length) {
    const header = archive.stdout.subarray(offset, offset + 512);
    const read = (start, size) => header.subarray(start, start + size).toString().replace(/\0.*$/, '');
    const name = read(0, 100); if (!name) break;
    const size = parseInt(read(124, 12).trim() || '0', 8), type = read(156, 1);
    if (type === '0' || type === '') files.set(name, archive.stdout.subarray(offset + 512, offset + 512 + size).toString('utf8'));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  prefix = [...files.keys()].some(p => p.startsWith('ruby/')) ? 'ruby/' : 'src/mem/ruby/';
  const index = new WorkspaceIndex(), base = 'file:///reference/';
  const started = performance.now();
  for (const [name, text] of files) if (/\.(sm|slicc)$/.test(name)) index.set(base + name, text);
  assert.ok(index.sources.size > 30, 'Expected a real gem5 protocol corpus');
  const parseMs = performance.now() - started;
  const engine = new ExternalTypes({
    read: async uri => files.get(uri.slice(base.length)),
    exists: async uri => files.has(uri.slice(base.length)) || [...files.keys()].some(p => p.startsWith(uri.slice(base.length).replace(/\/?$/, '/'))),
    list: async uri => { const dir = uri.slice(base.length), children = new Map(); for (const name of files.keys()) if (name.startsWith(dir)) { const rest = name.slice(dir.length), entry = rest.split('/')[0]; if (entry) children.set(entry, { name: entry, directory: rest.includes('/') }); } return [...children.values()]; }
  }, index);
  const flags = new DebugFlags(engine);
  const counts = {}, samples = {}, perFile = [], allHints = [];
  for (const source of index.sources.values()) {
    const debugFlags = source.tokens.some(t => t.text === 'DPRINTF') ? await flags.snapshot(source.uri) : undefined;
    const issues = diagnostics(index, source, { debugFlags });
    for (const issue of issues) { counts[issue.code] = (counts[issue.code] ?? 0) + 1; (samples[issue.code] ??= []).push({ file: source.uri.slice(base.length), text: source.text.slice(issue.start, issue.end), message: issue.message, line: source.text.slice(0, issue.start).split('\n').length }); }
    perFile.push({ file: source.uri.slice(base.length), issues: issues.length, symbols: source.symbols.length });
    allHints.push(...hints(index, source));
  }
  // This legacy source in the supplied snapshot has 494 opens / 493 closes.
  // Record its genuine syntax error, while requiring every other file to parse.
  for (const issue of samples.syntax ?? []) assert.ok(issue.file.endsWith('/MOESI_AMD_Base-Region-dir.sm') && issue.message === "Unclosed '{'", `Unexpected syntax error: ${JSON.stringify(issue)}`);
  assert.equal(counts.include ?? 0, 0, 'All reference includes must resolve');
  const mi = index.sources.get(base + prefix + 'protocol/MI_example-cache.sm'), analysis = new Analysis(index, mi);
  const actionToken = mi.tokens.find(t => mi.roles.get(t.index) === 'action');
  assert.ok(actionToken && analysis.resolve(actionToken.index)[0]?.kind === 'action', 'MI transition must resolve to an action');
  const cacheEntry = mi.tokens.find(t => t.text === 'cache_entry' && mi.tokens[t.index + 1]?.text === '.' && analysis.implicit('cache_entry', t.start));
  assert.ok(cacheEntry && analysis.members('Entry', cacheEntry.start).symbols.some(s => s.name === 'DataBlk'));
  assert.equal(analysis.implicit('cache_entry', cacheEntry.start).type, 'Entry');
  const chi = index.sources.get(base + prefix + 'protocol/chi/CHI-cache-actions.sm'), chiAnalysis = new Analysis(index, chi);
  const messageAccess = chi.tokens.find(t => t.text === 'in_msg' && chi.tokens[t.index + 1]?.text === '.' && chiAnalysis.implicit('in_msg', t.start));
  assert.ok(messageAccess, 'CHI include file must retain message scopes');
  const chiEntry = chi.tokens.find(t => t.text === 'cache_entry' && chiAnalysis.implicit('cache_entry', t.start));
  assert.ok(chiEntry, 'CHI must expose the implicit action variable');
  assert.equal(chiAnalysis.implicit('cache_entry', chiEntry.start).type, 'CacheEntry', 'CHI must choose its primary CacheEntry, not non-main DirEntry');
  const hammer = index.sources.get(base + prefix + 'protocol/MOESI_hammer-dir.sm'), hammerAnalysis = new Analysis(index, hammer);
  const hammerEntry = hammer.tokens.find(t => t.text === 'cache_entry' && hammerAnalysis.implicit('cache_entry', t.start));
  assert.equal(hammerAnalysis.implicit('cache_entry', hammerEntry.start).type, 'PfEntry', 'Hammer must exclude its non-main Entry');
  const debugFlags = await flags.snapshot(mi.uri); assert.ok(debugFlags.flags.some(flag => flag.name === 'RubySlicc'), 'Actual Ruby DebugFlag declarations must be available for completion');
  const types = index.sources.get(base + prefix + 'protocol/RubySlicc_Types.sm');
  for (const name of ['MessageBuffer', 'CacheMemory']) {
    const sym = types.symbols.find(s => s.name === name), info = await engine.inspect(sym);
    assert.equal(info.status, 'resolved', `${name} C++ source must be reachable`);
  }
  const region = index.sources.get(base + prefix + 'protocol/MOESI_AMD_Base-Region-dir.sm'), regionAnalysis = new Analysis(index, region);
  const recoveredActions = region.symbols.filter(s => s.kind === 'action').length, recoveredTransitions = region.transitions.length;
  const wd = region.symbols.find(s => s.kind === 'action' && s.name === 'wd_writeBackData'), wdUsages = regionAnalysis.related(wd);
  assert.equal(recoveredActions, 60); assert.equal(recoveredTransitions, 98); assert.equal(wdUsages.length, 14);
  for (const ref of wdUsages) assert.equal(regionAnalysis.resolve(ref.token.index)[0]?.id, wd.id);
  const typeAnalysis = new Analysis(index, types), ports = {};
  for (const name of ['InPort', 'OutPort']) ports[name] = typeAnalysis.members(name, types.symbols.find(s => s.name === name).nameStart).symbols.filter(s => s.kind === 'function').map(s => s.name);
  assert.deepEqual(ports.InPort.sort(), ['isReady', 'dequeue', 'recycle', 'isEmpty', 'isStallMapEmpty', 'getStallMapSize', 'hasStalledMsg'].sort());
  assert.deepEqual(ports.OutPort.sort(), ['enqueueDeferredMessages', 'isDeferredMsgMapEmpty'].sort());
  const mn = [...index.sources.values()].flatMap(s => s.symbols).find(s => s.name === 'MN_TBEStorage');
  const mnType = await engine.inspect(mn);
  assert.equal(mnType.status, 'resolved'); assert.equal(mnType.locations[0].qualifiedName, 'gem5::ruby::CHI::MN_TBEStorage');
  let enumDefaults = 0;
  for (const file of index.sources.values()) {
    const a = new Analysis(index, file);
    for (const i of file.defaults.keys()) if (a.enumDefault(i)?.member) { assert.equal(a.resolve(i)[0].kind, 'enumMember'); enumDefaults++; }
  }
  assert(enumDefaults > 0, 'Real enumeration defaults must resolve');
  const chiTransitions = [...index.sources.values()].find(s => s.uri.endsWith('/CHI-cache-transitions.sm'));
  assert.equal(chiTransitions.transitions.length, 226);
  const overlap = chiTransitions.transitions.find(s => s.complete && s.states.length > 1);
  assert(overlap, 'CHI must contain a valid multiline state list');
  const duplicateIndex = new WorkspaceIndex();
  for (const file of index.sources.values()) duplicateIndex.set(file.uri, file.text);
  const duplicate = duplicateIndex.set(chiTransitions.uri, chiTransitions.text + '\n' + chiTransitions.text.slice(overlap.start, overlap.end));
  assert.equal(diagnostics(duplicateIndex, duplicate).filter(i => i.code === 'transition-duplicate' && i.start > chiTransitions.text.length).length, 1);
  const release150 = { recoveredActions, recoveredTransitions, writeBackTransitions: wdUsages.length, ports, enumDefaults, externalMN: mnType.locations[0].qualifiedName, chiTransitions: chiTransitions.transitions.length, injectedDuplicateDetected: true };
  const chiCache = index.sources.get(base + prefix + 'protocol/chi/CHI-cache.sm'), cacheAnalysis = new Analysis(index, chiCache);
  const directory = chiCache.symbols.find(s => s.name === 'directory' && s.kind === 'field' && s.scope.kind === 'machine');
  assert(directory, 'CHI must declare its machine-owned directory');
  const directoryUsages = cacheAnalysis.related(directory), directoryReferences = cacheAnalysis.references(directory);
  assert.equal(directoryUsages.length, 8, 'CHI directory must expose all eight concrete usage statements');
  for (const ref of directoryReferences) {
    assert.equal(new Analysis(index, ref.source).resolve(ref.token.index)[0]?.id, directory.id);
    assert.deepEqual(index.machineContexts(ref.source, ref.token.start).map(context => context.symbol.id), [directory.scope.owner.id]);
  }
  const release160 = { machine: directory.scope.owner.name, field: directory.name, references: directoryReferences.length, usageStatements: directoryUsages.length, files: [...new Set(directoryUsages.map(ref => ref.source.uri.slice(base.length)))] };
  const symbols = [...index.sources.values()].reduce((n, s) => n + s.symbols.length, 0);
  const report = { reference: repo, ref, commit: hash.stdout.trim(), files: index.sources.size, symbols, hints: allHints.length, debugFlags: { names: debugFlags.flags.length, complete: debugFlags.complete }, primaryCacheEntries: { MI_example: 'Entry', CHI: 'CacheEntry', MOESI_hammer_directory: 'PfEntry' }, release150, release160, parseMs: Math.round(parseMs), totalMs: Math.round(performance.now() - started), diagnostics: counts, samples: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.slice(0, 50)])), perFile: perFile.sort((a, b) => b.issues - a.issues) };
  const reportPath = path.resolve(__dirname, '../.test/corpus-report.json'); fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, samples: undefined, perFile: undefined }, null, 2));
  console.log(`Detailed report: ${reportPath}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

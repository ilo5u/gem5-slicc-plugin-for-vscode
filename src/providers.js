'use strict';

const vscode = require('vscode');
const path = require('node:path');
const { Analysis, signature } = require('./core/analysis');
const { ownerOf, typeKinds } = require('./core/parser');
const { declarations, controls, builtins, attributes, primitives, gem5Types, keywords } = require('./core/lexer');
const { hints } = require('./core/hints');
const { diagnostics } = require('./core/diagnostics');
const { externalNames } = require('./core/cpp');
const { debugFlagPosition } = require('./core/printf');
const selector = { language: 'slicc' };
const tokenTypes = ['class', 'struct', 'enum', 'enumMember', 'function', 'method', 'parameter', 'property', 'variable', 'type'];
const tokenModifiers = ['declaration', 'readonly', 'defaultLibrary'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);

function kind(sym) {
  const K = vscode.SymbolKind;
  return { machine: K.Class, structure: K.Struct, external_type: K.Class, enumeration: K.Enum, state_declaration: K.Enum, enumMember: K.EnumMember, function: K.Function, action: K.Function, field: K.Field, variable: K.Variable, parameter: K.Variable, transition: K.Event, in_port: K.Event, out_port: K.Event }[sym.kind] ?? K.Variable;
}
function completionKind(sym) {
  const K = vscode.CompletionItemKind;
  return { machine: K.Class, structure: K.Struct, external_type: K.Class, enumeration: K.Enum, state_declaration: K.Enum, enumMember: K.EnumMember, function: K.Function, action: K.Function, field: K.Field, variable: K.Variable, parameter: K.Variable, in_port: K.Variable, out_port: K.Variable }[sym.kind] ?? K.Variable;
}
function semanticKind(sym) {
  if (sym.kind === 'function') return ownerOf(sym.scope, new Set(['structure', 'external_type'])) ? 'method' : 'function';
  return { machine: 'class', structure: 'struct', external_type: 'class', enumeration: 'enum', state_declaration: 'enum', enumMember: 'enumMember', action: 'function', field: 'property', parameter: 'parameter', variable: 'variable', in_port: 'variable', out_port: 'variable' }[sym.kind];
}
function sourceRange(document, start, end) { return new vscode.Range(document.positionAt(start), document.positionAt(end)); }
function tokenIndexAt(source, offset) {
  return source.tokenAt(offset)?.index ?? source.tokenAt(Math.max(0, offset - 1))?.index;
}
function descriptionMarkdown(value) {
  const escaped = value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/\n/g, '  \n');
  return new vscode.MarkdownString(escaped);
}

class Providers {
  constructor(workspace, context) {
    this.workspace = workspace; this.context = context;
    const L = vscode.languages;
    this.collection = L.createDiagnosticCollection('slicc'); this.diagnosticTimers = new Map(); this.diagnosticJobs = new Map();
    context.subscriptions.push(this, this.collection,
      L.registerCompletionItemProvider(selector, { provideCompletionItems: (...args) => this.complete(...args) }, '.', ':', '"'),
      L.registerDefinitionProvider(selector, { provideDefinition: (...args) => this.definition(...args) }),
      L.registerDeclarationProvider(selector, { provideDeclaration: (...args) => this.declaration(...args) }),
      L.registerImplementationProvider(selector, { provideImplementation: (...args) => this.implementation(...args) }),
      L.registerTypeDefinitionProvider(selector, { provideTypeDefinition: (...args) => this.typeDefinition(...args) }),
      L.registerReferenceProvider(selector, { provideReferences: (...args) => this.references(...args) }),
      L.registerHoverProvider(selector, { provideHover: (...args) => this.hover(...args) }),
      L.registerSignatureHelpProvider(selector, { provideSignatureHelp: (...args) => this.signatures(...args) }, '(', ','),
      L.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: (...args) => this.documentSymbols(...args) }),
      L.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: (...args) => this.workspaceSymbols(...args) }),
      L.registerFoldingRangeProvider(selector, { provideFoldingRanges: (...args) => this.folding(...args) }),
      L.registerDocumentSemanticTokensProvider(selector, { onDidChangeSemanticTokens: workspace.onDidChange, provideDocumentSemanticTokens: (...args) => this.semanticTokens(...args) }, legend),
      L.registerInlayHintsProvider(selector, { onDidChangeInlayHints: workspace.onDidChange, provideInlayHints: (...args) => this.inlayHints(...args) }),
      vscode.commands.registerCommand('slicc.findRelated', () => this.findRelated()),
      vscode.commands.registerCommand('slicc.reindex', async () => { workspace.ready = workspace.reindex(); await workspace.ready; vscode.window.setStatusBarMessage(`SLICC: indexed ${workspace.index.sources.size} files`, 4000); }),
      workspace.onDidChange(() => this.scheduleDiagnostics()),
      vscode.workspace.onDidCloseTextDocument(doc => { this.collection.delete(doc.uri); const key = doc.uri.toString(); clearTimeout(this.diagnosticTimers.get(key)); this.diagnosticTimers.delete(key); this.diagnosticJobs.get(key)?.cancel(); this.diagnosticJobs.get(key)?.dispose(); this.diagnosticJobs.delete(key); })
    );
    void workspace.ready.then(() => this.scheduleDiagnostics());
  }
  dispose() {
    for (const timer of this.diagnosticTimers.values()) clearTimeout(timer);
    for (const job of this.diagnosticJobs.values()) { job.cancel(); job.dispose(); }
    this.diagnosticTimers.clear(); this.diagnosticJobs.clear();
  }
  async session(document, token) {
    const source = await this.workspace.source(document);
    return new Analysis(this.workspace.index, source, () => !!token?.isCancellationRequested);
  }
  async location(sym) {
    const uri = vscode.Uri.parse(sym.uri);
    const source = this.workspace.index.sources.get(sym.uri);
    if (source) return new vscode.Location(uri, this.indexedRange(source, sym.nameStart, sym.nameEnd));
    const document = await vscode.workspace.openTextDocument(uri);
    return new vscode.Location(uri, sourceRange(document, sym.nameStart, sym.nameEnd));
  }
  indexedRange(source, start, end) {
    const a = source.positionAt(start), b = source.positionAt(end);
    return new vscode.Range(a.line, a.character, b.line, b.character);
  }
  async link(sym, origin) {
    const uri = vscode.Uri.parse(sym.uri), source = this.workspace.index.sources.get(sym.uri);
    if (source) return { originSelectionRange: origin, targetUri: uri, targetRange: this.indexedRange(source, sym.start ?? sym.nameStart, sym.end ?? sym.nameEnd), targetSelectionRange: this.indexedRange(source, sym.nameStart, sym.nameEnd) };
    const doc = await vscode.workspace.openTextDocument(uri);
    return { originSelectionRange: origin, targetUri: uri, targetRange: sourceRange(doc, sym.start ?? sym.nameStart, sym.end ?? sym.nameEnd), targetSelectionRange: sourceRange(doc, sym.nameStart, sym.nameEnd) };
  }
  async usageLink(ref, origin) {
    const uri = vscode.Uri.parse(ref.source.uri);
    return { originSelectionRange: origin, targetUri: uri, targetRange: this.indexedRange(ref.source, ref.start ?? ref.token.start, ref.end ?? ref.token.end), targetSelectionRange: this.indexedRange(ref.source, ref.token.start, ref.token.end) };
  }
  item(sym, document, range) {
    const item = new vscode.CompletionItem(sym.name, completionKind(sym)); item.detail = signature(sym);
    const source = this.workspace.index.sources.get(sym.uri), detail = source && new Analysis(this.workspace.index, source).description(sym);
    if (detail) item.documentation = descriptionMarkdown(detail);
    item.range = range; item.sortText = '0' + sym.name;
    if (sym.implicit) item.detail = `${sym.type ?? 'Unknown type'} (implicit SLICC variable)`;
    return item;
  }
  navigationTarget(analysis, sym) {
    if (!sym.implicit) return sym;
    if (['in_msg', 'out_msg'].includes(sym.name)) return { ...sym, start: sym.nameStart, end: sym.nameEnd };
    if (sym.name === 'cache_entry') return sym.typeTarget;
    return this.workspace.index.contextComplete(analysis.source, sym.nameStart) ? analysis.typeDeclaration(sym.type, this.workspace.index.sources.get(sym.uri), sym.nameStart) : undefined;
  }
  async complete(document, position, token) {
    const a = await this.session(document, token), { source, t } = a, offset = document.offsetAt(position);
    if (token.isCancellationRequested) return [];
    let i = tokenIndexAt(source, offset), current = t[i];
    if (source.comments.some(c => c.start <= offset && offset < c.end)) return [];
    if (current?.kind === 'string' && t[i - 1]?.text === 'include') {
      const results = [];
      const last = /["']$/.test(current.text) && current.text.length > 1 ? current.end - 1 : current.end;
      const range = sourceRange(document, current.start + 1, last);
      for (const other of this.workspace.index.sources.values()) {
        if (other === source) continue;
        const from = document.uri, to = vscode.Uri.parse(other.uri);
        if (from.scheme !== to.scheme || from.authority !== to.authority) continue;
        const relative = path.posix.relative(path.posix.dirname(from.path), to.path);
        const item = new vscode.CompletionItem(relative, vscode.CompletionItemKind.File); item.range = range; results.push(item);
      }
      return results;
    }
    if (current?.kind === 'string') return [];
    const insideWord = current && current.start < offset && current.end >= offset && ['identifier', 'keyword'].includes(current.kind);
    const range = insideWord ? sourceRange(document, current.start, current.end) : new vscode.Range(position, position);
    if (debugFlagPosition(source, offset)) {
      const flags = await this.workspace.debugFlags.snapshot(source.uri);
      if (token.isCancellationRequested) return [];
      return flags.flags.map(flag => {
        const item = new vscode.CompletionItem(flag.name, vscode.CompletionItemKind.Constant);
        item.detail = 'Ruby debug flag'; item.range = range; return item;
      });
    }
    if (insideWord) i--;
    else if (current && current.start >= offset) i--;
    const operator = t[i]?.text;
    if (operator === '.') {
      const receiver = a.receiver(i);
      return a.members(receiver.type, receiver.at ?? offset, receiver.source ?? source).symbols.map(sym => this.item(sym, document, range));
    }
    if (operator === ':' || operator === '::') {
      const types = this.workspace.index.types(source, offset, t[i - 1]?.text);
      return types.flatMap(sym => sym.bodyScope?.symbols ?? []).filter(sym => ['enumMember', 'function', 'field'].includes(sym.kind)).map(sym => this.item(sym, document, range));
    }
    const out = [], seen = new Set();
    const add = sym => {
      if (sym.kind === 'transition') return;
      const key = sym.kind === 'function' ? signature(sym) : sym.name;
      if (!sym.name || seen.has(key)) return; seen.add(key); out.push(this.item(sym, document, range));
    };
    for (const sym of a.visibleVariables(offset)) add(sym);
    const inAction = ownerOf(source.scopeAt(offset), new Set(['action']));
    for (const sym of this.workspace.index.visible(source, offset)) if (!['in_port', 'out_port'].includes(sym.kind) && !(inAction && sym.kind === 'action')) add(sym);
    for (const name of new Set([...declarations, ...controls, ...builtins, ...attributes, ...primitives, 'error', 'assert', ...gem5Types])) if (!seen.has(name)) {
      const item = new vscode.CompletionItem(name, gem5Types.includes(name) || primitives.has(name) ? vscode.CompletionItemKind.TypeParameter : vscode.CompletionItemKind.Keyword);
      item.range = range; item.sortText = '1' + name; out.push(item);
    }
    return out;
  }
  async declaration(document, position, token) {
    const a = await this.session(document, token), i = tokenIndexAt(a.source, document.offsetAt(position));
    const origin = a.t[i] && sourceRange(document, a.t[i].start, a.t[i].end);
    return Promise.all(a.resolve(i).map(sym => this.navigationTarget(a, sym)).filter(Boolean).map(sym => this.link(sym, origin)));
  }
  async definition(document, position, token) {
    const a = await this.session(document, token), i = tokenIndexAt(a.source, document.offsetAt(position));
    if (i === undefined) return [];
    const origin = sourceRange(document, a.t[i].start, a.t[i].end), declared = a.source.declarations.get(i);
    if (a.source.roles.get(i) === 'include') {
      const include = a.source.includes.find(inc => inc.start === a.t[i].start), target = include && this.workspace.index.includeTarget(a.source, include);
      return target ? [await this.link({ uri: target.uri, start: 0, end: 0, nameStart: 0, nameEnd: 0 }, origin)] : [];
    }
    if (declared) {
      if (externalNames(declared) !== undefined) {
        const external = await this.workspace.external.inspect(declared);
        if (external?.locations.length) return Promise.all(external.locations.map(loc => this.link({ ...loc, nameStart: loc.start, nameEnd: loc.end }, origin)));
      }
      if (declared.kind === 'function' && !declared.hasBody) {
        const definitions = [...this.workspace.index.sources.values()].flatMap(s => s.symbols).filter(s => s.kind === 'function' && s.hasBody && this.workspace.index.sameSymbol(s, declared));
        if (definitions.length) return Promise.all(definitions.map(s => this.link(s, origin)));
      }
      if (['function', 'action', 'field', 'enumMember'].includes(declared.kind)) {
        const related = a.related(declared);
        if (related.length) return Promise.all(related.map(ref => this.usageLink(ref, origin)));
      }
    }
    return Promise.all(a.resolve(i).map(sym => this.navigationTarget(a, sym)).filter(Boolean).map(sym => this.link(sym, origin)));
  }
  async implementation(document, position, token) {
    const a = await this.session(document, token), i = tokenIndexAt(a.source, document.offsetAt(position)), symbols = a.resolve(i);
    const result = [];
    for (const sym of symbols) for (const source of this.workspace.index.sources.values()) for (const other of source.symbols) if (other.kind === 'function' && other.hasBody && this.workspace.index.sameSymbol(sym, other)) result.push(await this.location(other));
    return result;
  }
  async typeDefinition(document, position, token) {
    const a = await this.session(document, token), i = tokenIndexAt(a.source, document.offsetAt(position)), symbols = a.resolve(i);
    const result = [];
    for (const sym of symbols) {
      const type = typeKinds.has(sym.kind) ? sym : a.typeDeclaration(sym.type, this.workspace.index.sources.get(sym.uri), sym.nameStart);
      if (type) result.push(await this.location(type));
    }
    return result;
  }
  async references(document, position, context, token) {
    const a = await this.session(document, token), i = tokenIndexAt(a.source, document.offsetAt(position)), symbols = a.resolve(i), result = [], seen = new Set();
    for (const sym of symbols) for (const ref of a.references(sym, context.includeDeclaration)) {
      const key = `${ref.source.uri}:${ref.token.start}`; if (seen.has(key)) continue; seen.add(key);
      const uri = vscode.Uri.parse(ref.source.uri);
      result.push(new vscode.Location(uri, this.indexedRange(ref.source, ref.token.start, ref.token.end)));
    }
    return result;
  }
  async hover(document, position, token) {
    const a = await this.session(document, token), i = tokenIndexAt(a.source, document.offsetAt(position)), symbols = a.resolve(i);
    if (!symbols.length) return undefined;
    const markdown = new vscode.MarkdownString();
    for (const sym of symbols.slice(0, 12)) {
      markdown.appendCodeblock(sym.implicit ? `${sym.type} ${sym.name}` : signature(sym), 'slicc');
      if (symbols.every(other => this.workspace.index.sameSymbol(sym, other))) {
        const detail = a.description(sym); if (detail) markdown.appendMarkdown(descriptionMarkdown(detail).value).appendMarkdown('\n\n');
      }
      if (sym.implicit) markdown.appendText('Implicit SLICC binding.');
      markdown.appendMarkdown('\n\n');
    }
    return new vscode.Hover(markdown, sourceRange(document, a.t[i].start, a.t[i].end));
  }
  async signatures(document, position, token) {
    const a = await this.session(document, token), offset = document.offsetAt(position);
    let open = -1;
    for (let i = 0; i < a.t.length && a.t[i].start < offset; i++) {
      if (a.get(i) === '(' && (a.t[i - 1]?.kind === 'identifier' || a.get(i - 2) === '.') && !a.source.declarations.has(i - 1)) {
        const close = a.source.pairs.get(i);
        if (close === undefined || a.t[close].start >= offset) open = i;
      }
    }
    if (open < 0) return undefined;
    const call = a.call(open - 1); if (!call?.allCandidates.length) return undefined;
    let argument = 0;
    for (let i = open + 1; i < a.t.length && a.t[i].start < offset; i++) {
      if (a.get(i) === ',') argument++;
      else if (a.source.pairs.get(i) > i && a.t[a.source.pairs.get(i)].start < offset) i = a.source.pairs.get(i);
    }
    const result = new vscode.SignatureHelp();
    const seen = new Set(), candidates = call.allCandidates.filter(s => { const key = signature(s); if (seen.has(key)) return false; seen.add(key); return true; });
    result.signatures = candidates.map(sym => {
      const info = new vscode.SignatureInformation(signature(sym), a.description(sym));
      let start = `${sym.type} ${sym.name}(`.length;
      info.parameters = sym.params.map(p => {
        const label = `${p.type}${p.name ? ' ' + p.name : ''}`, end = start + label.length;
        const parameter = new vscode.ParameterInformation([start, end]); start = end + 2; return parameter;
      });
      info.activeParameter = sym.params.length ? Math.min(argument, sym.params.length - 1) : undefined;
      return info;
    });
    result.activeSignature = Math.max(0, candidates.findIndex(s => call.selected.includes(s)));
    result.activeParameter = argument;
    return result;
  }
  async documentSymbols(document, token) {
    const a = await this.session(document, token);
    const make = sym => {
      const name = sym.kind === 'transition' ? `transition(${sym.name})` : sym.name;
      const item = new vscode.DocumentSymbol(name || sym.kind, sym.kind === 'function' ? signature(sym) : sym.type ?? '', kind(sym), sourceRange(document, sym.start, Math.max(sym.end, sym.nameEnd)), sourceRange(document, sym.nameStart, sym.nameEnd));
      item.children = sym.children.filter(s => !['parameter', 'variable'].includes(s.kind)).map(make); return item;
    };
    return a.source.root.symbols.map(make);
  }
  async workspaceSymbols(query, token) {
    await this.workspace.ready;
    const out = [], search = query.toLocaleLowerCase();
    for (const source of this.workspace.index.sources.values()) {
      if (token.isCancellationRequested) break;
      for (const sym of source.symbols) if (!['parameter', 'variable', 'transition'].includes(sym.kind) && sym.name.toLocaleLowerCase().includes(search)) {
        out.push(new vscode.SymbolInformation(sym.name, kind(sym), ownerOf(sym.scope, new Set(['machine', 'structure', 'external_type']))?.name ?? '', await this.location(sym)));
      }
    }
    return out;
  }
  async folding(document, context, token) {
    const a = await this.session(document, token), ranges = [], seen = new Set();
    const add = (start, end, kind) => {
      const from = document.positionAt(start).line, to = document.positionAt(end).line;
      if (to > from && !seen.has(`${from}:${to}`)) { seen.add(`${from}:${to}`); ranges.push(new vscode.FoldingRange(from, to - (kind === vscode.FoldingRangeKind.Comment ? 0 : 1), kind)); }
    };
    for (const [open, close] of a.source.pairs) if (open < close && a.get(open) === '{') add(a.t[open].start, a.t[close].start);
    for (const comment of a.source.comments) if (comment.text.startsWith('/*')) add(comment.start, Math.max(comment.start, comment.end - 1), vscode.FoldingRangeKind.Comment);
    const regions = [];
    for (const comment of a.source.comments) {
      if (/^\/\/\s*#?region\b/.test(comment.text)) regions.push(comment);
      else if (/^\/\/\s*#?endregion\b/.test(comment.text) && regions.length) add(regions.pop().start, comment.end, vscode.FoldingRangeKind.Region);
    }
    return ranges;
  }
  async semanticTokens(document, token) {
    const a = await this.session(document, token), builder = new vscode.SemanticTokensBuilder(legend);
    for (const t of a.t) {
      if (token.isCancellationRequested) break;
      if (!['identifier', 'keyword'].includes(t.kind) || a.source.roles.get(t.index) === 'attribute') continue;
      const sym = a.resolve(t.index)[0]; if (!sym) continue;
      const type = a.generated(t.index) ? 'function' : semanticKind(sym); if (!type) continue;
      const modifiers = [];
      if (a.source.declarations.has(t.index)) modifiers.push('declaration');
      if (sym.kind === 'enumMember') modifiers.push('readonly');
      if (sym.implicit) modifiers.push('defaultLibrary');
      builder.push(sourceRange(document, t.start, t.end), type, modifiers);
    }
    return builder.build();
  }
  async inlayHints(document, range, token) {
    const a = await this.session(document, token), config = vscode.workspace.getConfiguration('slicc', document);
    return hints(this.workspace.index, a.source, { parameterNames: config.get('inlayHints.parameterNames'), implicitTypes: config.get('inlayHints.implicitTypes') }, () => token.isCancellationRequested)
      .filter(h => range.contains(document.positionAt(h.offset)))
      .map(h => { const item = new vscode.InlayHint(document.positionAt(h.offset), h.label, h.kind === 'type' ? vscode.InlayHintKind.Type : vscode.InlayHintKind.Parameter); item.paddingLeft = h.kind === 'type'; item.paddingRight = h.kind === 'parameter'; return item; });
  }
  scheduleDiagnostics() {
    for (const doc of vscode.workspace.textDocuments) if (doc.languageId === 'slicc') {
      const key = doc.uri.toString(); clearTimeout(this.diagnosticTimers.get(key));
      this.diagnosticJobs.get(key)?.cancel(); this.diagnosticJobs.get(key)?.dispose();
      const job = new vscode.CancellationTokenSource(); this.diagnosticJobs.set(key, job);
      this.diagnosticTimers.set(key, setTimeout(() => { this.diagnosticTimers.delete(key); void this.validate(doc, job.token).catch(e => this.workspace.log(e)); }, 180));
    }
  }
  async validate(document, token) {
    if (document.isClosed || token.isCancellationRequested) return;
    const config = vscode.workspace.getConfiguration('slicc', document);
    if (!config.get('diagnostics.enabled')) { this.collection.delete(document.uri); return; }
    const version = document.version, a = await this.session(document, token);
    const flags = config.get('diagnostics.printf') && a.t.some(t => t.text === 'DPRINTF') ? await this.workspace.debugFlags.snapshot(a.source.uri) : undefined;
    if (token.isCancellationRequested) return;
    const issues = diagnostics(this.workspace.index, a.source, { members: config.get('diagnostics.members'), functionResults: config.get('diagnostics.functionResults'), calls: config.get('diagnostics.calls'), transitions: config.get('diagnostics.transitions'), printf: config.get('diagnostics.printf'), debugFlags: flags }, () => token.isCancellationRequested);
    if (config.get('diagnostics.externalTypes')) for (const sym of a.source.symbols) {
      if (token.isCancellationRequested) return;
      const info = await this.workspace.external.inspect(sym);
      if (info && ['missing', 'unavailable'].includes(info.status)) issues.push({ start: sym.nameStart, end: sym.nameEnd, severity: info.status === 'missing' ? 'error' : 'warning', code: 'external-type', message: info.status === 'missing' ? `No reachable C++ definition for '${info.names.join("' or '")}'` : info.reason ?? `Ruby Kconfig/SConscript source context is unavailable for '${sym.name}'` });
    }
    if (token.isCancellationRequested || document.isClosed || document.version !== version) return;
    this.collection.set(document.uri, issues.map(issue => {
      const item = new vscode.Diagnostic(sourceRange(document, issue.start, issue.end), issue.message, issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      item.source = 'SLICC'; item.code = issue.code; return item;
    }));
  }
  async findRelated() {
    const editor = vscode.window.activeTextEditor; if (!editor || editor.document.languageId !== 'slicc') return;
    const a = await this.session(editor.document), i = tokenIndexAt(a.source, editor.document.offsetAt(editor.selection.active)), symbols = a.resolve(i);
    const refs = symbols.flatMap(s => a.related(s)), seen = new Set(), items = [];
    const limit = Math.max(1, vscode.workspace.getConfiguration('slicc').get('navigation.maxStatementLength', 160));
    for (const ref of refs) {
      const key = `${ref.source.uri}:${ref.start}`; if (seen.has(key)) continue; seen.add(key);
      const text = ref.source.text.slice(ref.start, ref.end).replace(/\s+/g, ' ').trim(), characters = Array.from(text);
      const label = characters.length <= limit ? text : characters.slice(0, Math.max(0, limit - 1)).join('') + '…';
      const uri = vscode.Uri.parse(ref.source.uri), caller = ownerOf(ref.source.scopeAt(ref.token.start), new Set(['function', 'action', 'in_port']));
      items.push({ label, description: `${caller?.name ? caller.name + ' · ' : ''}${vscode.workspace.asRelativePath(uri)}:${ref.source.positionAt(ref.token.start).line + 1}`, ref });
    }
    if (!items.length) { vscode.window.setStatusBarMessage('SLICC: no related usages found', 3000); return; }
    const item = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'Select a transition, calling statement, or member usage', matchOnDescription: true });
    if (item) { const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.ref.source.uri)); await vscode.window.showTextDocument(doc, { selection: sourceRange(doc, item.ref.token.start, item.ref.token.end) }); }
  }
}

module.exports = { Providers, legend, tokenIndexAt };

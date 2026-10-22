'use strict';

const vscode = require('vscode');
const { signature } = require('./core/analysis');

function symbolIcon(context, kind) {
  const name = { action: 'action', function: 'function', machine: 'machine', structure: 'structure', external_type: 'structure', enumeration: 'enum', state_declaration: 'enum', enumMember: 'enum', transition: 'transition' }[kind];
  return name ? { light: vscode.Uri.joinPath(context.extensionUri, `icons/slicc_${name}.svg`), dark: vscode.Uri.joinPath(context.extensionUri, `icons/slicc_${name}_dark.svg`) } : new vscode.ThemeIcon('symbol-field');
}

class SymbolsView {
  constructor(workspace, context) {
    this.workspace = workspace; this.context = context; this.change = new vscode.EventEmitter(); this.onDidChangeTreeData = this.change.event;
    context.subscriptions.push(this.change, workspace.onDidChange(() => this.change.fire()), vscode.window.onDidChangeActiveTextEditor(() => this.change.fire()), vscode.window.registerTreeDataProvider('slicc.symbols', this));
  }
  async getChildren(symbol) {
    if (symbol) return symbol.children.filter(child => !['parameter', 'variable'].includes(child.kind));
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'slicc') return [];
    const source = await this.workspace.source(editor.document); return source.root.symbols;
  }
  getTreeItem(symbol) {
    const source = this.workspace.index.sources.get(symbol.uri), children = symbol.children.filter(child => !['parameter', 'variable'].includes(child.kind));
    const label = symbol.kind === 'transition' ? `transition(${symbol.name})` : symbol.name;
    const item = new vscode.TreeItem(label, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = symbol.id; item.iconPath = symbolIcon(this.context, symbol.kind); item.tooltip = signature(symbol); item.description = symbol.type;
    if (source) {
      const a = source.positionAt(symbol.nameStart), b = source.positionAt(symbol.nameEnd);
      item.command = { command: 'vscode.open', title: 'Go to SLICC declaration', arguments: [vscode.Uri.parse(symbol.uri), { selection: new vscode.Range(a.line, a.character, b.line, b.character) }] };
    }
    return item;
  }
}

module.exports = { SymbolsView, symbolIcon };

'use strict';

const { Workspace } = require('./workspace');
const { Providers } = require('./providers');
const { SymbolsView } = require('./symbols-view');

function activate(context) {
  const workspace = new Workspace(context);
  const providers = new Providers(workspace, context);
  const symbolsView = new SymbolsView(workspace, context);
  return { ready: workspace.ready, workspace, providers, symbolsView };
}

function deactivate() {}

module.exports = { activate, deactivate };

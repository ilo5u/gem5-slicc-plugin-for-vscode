'use strict';

function transitionDiagnostics(index, source, cancelled = () => false) {
  const out = [];
  if (source.issues.length) return out;
  if (!index.transitionCache) index.transitionCache = new Map();
  for (const transition of source.transitions) {
    if (cancelled()) break;
    const owners = index.machineContexts(source, transition.nameStart);
    if (owners.length > 1) continue;
    const owner = owners[0], expansion = owner ? index.expansion(owner.root, owner.symbol) : index.expansion(source);
    if (!expansion.complete) continue;
    if (!index.transitionCache.has(expansion)) {
      const results = new Map(), pairs = new Set();
      for (const { symbol } of expansion.transitions) {
        if (cancelled()) return out;
        if (!symbol.complete) continue;
        const diagnostics = [], duplicates = [];
        for (const action of symbol.actionTokens) if (!expansion.actions.has(action.text)) diagnostics.push({ start: action.start, end: action.end, message: `Unknown transition action '${action.text}'`, code: 'transition-action', severity: 'error' });
        for (const state of symbol.states) for (const event of symbol.events) {
          const key = JSON.stringify([state, event]);
          if (pairs.has(key)) duplicates.push({ state, event });
        }
        if (duplicates.length) {
          const { state, event } = duplicates[0], extra = duplicates.length > 1 ? ` (and ${duplicates.length - 1} more)` : '';
          diagnostics.push({ start: symbol.start, end: symbol.headerEnd, message: `Duplicate transition for state '${state}' and event '${event}'${extra}`, code: 'transition-duplicate', severity: 'error' });
        }
        for (const state of symbol.states) for (const event of symbol.events) pairs.add(JSON.stringify([state, event]));
        results.set(symbol, diagnostics);
      }
      index.transitionCache.set(expansion, results);
    }
    out.push(...(index.transitionCache.get(expansion).get(transition) ?? []));
  }
  return out;
}

module.exports = { transitionDiagnostics };

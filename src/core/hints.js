'use strict';

const { Analysis } = require('./analysis');

function hints(index, source, options = {}, cancelled) {
  const analysis = new Analysis(index, source, cancelled), out = [], seen = new Set();
  for (const token of source.tokens) {
    if (cancelled?.()) break;
    const i = token.index;
    if (source.declarations.has(i)) continue;
    if (options.parameterNames !== false && (token.kind === 'identifier' || analysis.get(i - 1) === '.') && analysis.get(i + 1) === '(') {
      const call = analysis.call(i);
      if (call?.complete && call.selected.length) for (let n = 0; n < call.arguments.length; n++) {
        const arg = call.arguments[n], names = call.selected.map(x => x.params[n]?.name);
        if (!names[0] || !names.every(x => x === names[0])) continue;
        if (arg.end === arg.begin + 1 && source.tokens[arg.begin]?.text === names[0]) continue;
        out.push({ offset: arg.start, label: `${names[0]}:`, kind: 'parameter' });
      }
    }
    if (options.implicitTypes !== false && ['in_msg', 'out_msg', 'tbe', 'cache_entry', 'address'].includes(token.text)) {
      if (['.', ':', '::'].includes(analysis.get(i - 1)) || [':', '::'].includes(analysis.get(i + 1)) || ['type', 'attribute'].includes(source.roles.get(i))) continue;
      const binding = analysis.implicit(token.text, token.start);
      if (!binding?.type || seen.has(binding.id)) continue;
      seen.add(binding.id); out.push({ offset: token.end, label: `: ${binding.type}`, kind: 'type', binding });
    }
  }
  return out;
}

module.exports = { hints };

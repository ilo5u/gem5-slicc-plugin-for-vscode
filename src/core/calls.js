'use strict';

function callArguments(source, open) {
  const close = source.pairs.get(open), t = source.tokens;
  if (close === undefined || close <= open || t[open]?.text !== '(' || t[close]?.text !== ')') return undefined;
  if (close === open + 1) return [];
  if (t[close - 1].text === ',') return undefined;
  const args = source.parts(open + 1, close);
  if (args.some(([a, b]) => a === b || t.slice(a, b).some(x => x.text === ';'))) return undefined;
  return args;
}

module.exports = { callArguments };

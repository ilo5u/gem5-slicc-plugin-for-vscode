'use strict';

// Mask Python/Kconfig comments and docstrings while retaining literal strings
// and source offsets. Build files are inspected as text, never executed.
function pythonText(text) {
  let out = '', quote = '', escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quote && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const delimiter = text.slice(i, i + 3), end = text.indexOf(delimiter, i + 3), last = end < 0 ? text.length : end + 3;
      out += text.slice(i, last).replace(/[^\r\n]/g, ' '); i = last - 1; continue;
    }
    if (!quote && c === '#') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } if (i < text.length) out += '\n'; continue; }
    out += c;
    if (escape) { escape = false; continue; }
    if (quote && c === '\\') { escape = true; continue; }
    if (quote === c) quote = ''; else if (!quote && (c === '"' || c === "'")) quote = c;
  }
  return out;
}

module.exports = { pythonText };

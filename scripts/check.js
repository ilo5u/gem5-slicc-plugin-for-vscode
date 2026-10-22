'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let count = 0;
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
      count++;
    } else if (file.endsWith('.json')) {
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { console.error(file, error.message); process.exitCode = 1; }
    }
  }
}
visit(root);
if (!process.exitCode) console.log(`Checked ${count} JavaScript files and all JSON files.`);

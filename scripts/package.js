'use strict';

// Dependency-free VSIX / OPC packaging. The archive uses standard ZIP deflate,
// CRC-32 and the same manifest/assets layout consumed by VS Code's installer.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Keep the offline packager aligned with the file rules used by vsce.
// This project's ignore file uses literal paths, *, ? and ** globs.
function ignorePattern(pattern) {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { expression += '(?:.*/)?'; i++; }
      else expression += '.*';
    } else if (c === '*') expression += '[^/]*';
    else if (c === '?') expression += '[^/]';
    else expression += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(expression + '$');
}
const excludeRules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(ignorePattern);
function packageExcluded(name) { return excludeRules.some(rule => rule.test(name.replace(/\\/g, '/'))); }
const escapeXml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

function zip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, input] of entries) {
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input), filename = Buffer.from(name), compressed = zlib.deflateRawSync(data), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, compressed);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, filename); offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function packageExtension() {
  const entries = [];
  const add = name => { if (!packageExcluded(name)) entries.push(['extension/' + name.replace(/\\/g, '/'), fs.readFileSync(path.join(root, name))]); };
  const walk = name => {
    if (packageExcluded(name.replace(/\\/g, '/') + '/')) return;
    for (const entry of fs.readdirSync(path.join(root, name), { withFileTypes: true })) {
      const file = path.join(name, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file);
      else if (entry.isFile()) add(file);
    }
  };
  for (const name of ['package.json', 'language-configuration.json', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']) add(name);
  for (const name of ['src', 'syntaxes', 'examples', 'docs', 'icons']) walk(name);
  entries.push(['[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + [['json', 'application/json'], ['js', 'application/javascript'], ['md', 'text/markdown'], ['xml', 'application/xml'], ['svg', 'image/svg+xml'], ['png', 'image/png'], ['vsixmanifest', 'text/xml'], ['sm', 'text/plain'], ['slicc', 'text/plain']].map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('') + '<Override PartName="/extension/LICENSE" ContentType="text/plain"/><Override PartName="/extension/NOTICE" ContentType="text/plain"/></Types>']);
  const x = escapeXml;
  entries.push(['extension.vsixmanifest', `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata><Identity Language="en-US" Id="${x(manifest.name)}" Version="${x(manifest.version)}" Publisher="${x(manifest.publisher)}"/><DisplayName>${x(manifest.displayName)}</DisplayName><Description xml:space="preserve">${x(manifest.description)}</Description><Tags>${x(manifest.keywords.join(','))}</Tags><Categories>${x(manifest.categories.join(','))}</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${x(manifest.engines.vscode)}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/><Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/></Properties><License>extension/LICENSE</License></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/>${manifest.icon ? `<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${x(manifest.icon)}" Addressable="true"/>` : ''}</Assets>
</PackageManifest>`]);
  const target = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, zip(entries));
  console.log(`Packaged ${entries.length} files: ${target} (${fs.statSync(target).size} bytes)`);
  return target;
}
if (require.main === module) packageExtension();
module.exports = { zip, crc32, packageExtension, packageExcluded };

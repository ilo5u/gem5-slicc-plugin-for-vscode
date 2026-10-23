'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { packageExtension } = require('./package');
const root = path.resolve(__dirname, '..'), manifest = require('../package.json');
const testDir = path.join(root, '.test/vscode'), userData = path.join(testDir, 'user-data'), extensions = path.join(testDir, 'extensions');
const executable = process.env.VSCODE_EXECUTABLE || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData/Local'), 'Programs/Microsoft VS Code/Code.exe') : process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' : '/usr/share/code/code');
if (!fs.existsSync(executable)) throw new Error('Set VSCODE_EXECUTABLE to the installed VS Code executable.');
fs.mkdirSync(testDir, { recursive: true });
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User/settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.enableExperiments': false, 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'workbench.tips.enabled': false, 'slicc.index.includePaths': [path.join(testDir, 'includes')] }, null, 2));
for (const [name, text] of Object.entries({
  'navigation160/Owner.sm': `structure(Holder) { int directory; }
machine(MachineType:Owner) {
  int directory;
  Holder holder;
  void consume(int first, int second);
  include "Actions.sm";
  include "Shared.sm";
  void parameter(int directory) { consume(directory, directory); }
  action(local, "l") {
    consume(directory, directory);
    { int directory; consume(directory, directory); }
    holder.directory := 1;
  }
}
`,
  'navigation160/Actions.sm': 'include "Functions.sm";\naction(included, "i") { consume(directory, directory); }\n',
  'navigation160/Functions.sm': 'void includedRead() { consume(directory, directory); }\n',
  'navigation160/Other.sm': 'machine(MachineType:Other) { int directory; include "Shared.sm"; action(other, "o") { directory := 2; } }\n',
  'navigation160/Shared.sm': 'void ambiguousRead() { directory := 1; }\n',
  'navigation160/Container.sm': 'machine(MachineType:Container) { int directory; include "Fragment.sm"; }\n',
  'navigation160/Fragment.sm': 'action(container, "c") { directory := 1; } machine(MachineType:Child) { int directory; include "ChildActions.sm"; }\n',
  'navigation160/ChildActions.sm': 'void childRead() { directory := 2; }\n',
  'navigation160/Many.sm': 'machine(MachineType:Many) { int directory; void consume(int first, int second); action(many, "m") {\n' + Array.from({ length: 45 }, () => 'consume(directory, directory);').join('\n') + '\n} }\n',
  'ruby/SConstruct': '',
  'ruby/Kconfig': 'rsource "protocol/Kconfig"', 'ruby/protocol/Kconfig': '',
  'ruby/SConscript': 'MakeInclude("network/MessageBuffer.hh")\nDebugFlag("Ruby")\nCompoundFlag("RubyAll", ["Ruby"])\n',
  'ruby/network/MessageBuffer.hh': 'namespace gem5::ruby { class MessageBuffer {}; }\n',
  'ruby/protocol/External.sm': 'structure(MessageBuffer, external="yes") {}\n',
  'includes/Shared.sm': 'structure(Shared) { int Payload; }\n',
  'gem5/SConstruct': '',
  'gem5/src/mem/SConscript': 'DebugFlag("HtmMem")\n',
  'gem5/src/mem/ruby/Kconfig': 'rsource "protocol/Kconfig"\n',
  'gem5/src/mem/ruby/protocol/Kconfig': 'config RUBY_PROTOCOL_CHI\n bool "CHI"\nconfig RUBY_PROTOCOL_Other\n bool "Other"\n',
  'gem5/src/mem/ruby/SConscript': 'DebugFlag("Ruby")\nMakeInclude("Types.hh")\n',
  'gem5/src/mem/ruby/Types.hh': 'namespace gem5::ruby::CHI { class Scoped {}; }\nnamespace gem5::ruby::Other { class Scoped {}; }\n',
  'gem5/src/mem/ruby/protocol/Release.slicc': 'protocol "CHI"; include "Release.sm";\n',
  'gem5/src/mem/ruby/protocol/Release.sm': `enumeration(Global) { G; }
structure(InPort) { bool isReady(int current_time); int dequeue(int current_time); void recycle(int current_time, int latency); bool isEmpty(); bool isStallMapEmpty(); int getStallMapSize(); bool hasStalledMsg(int addr); }
structure(OutPort) { void enqueueDeferredMessages(int addr, int current_time, int delay); bool isDeferredMsgMapEmpty(int addr); }
structure(Message) { int Payload; }
machine(MachineType:Release) {
  state_declaration(State) { I; S; }
  enumeration(Event) { Load; Store; }
  enumeration(Mode) { Read_Only; }
  structure(Fields) { Mode Initial, default=Mode_Read_Only; }
  structure(Scoped, external="yes") {}
  int queue;
  in_port(input, Message, queue) {}
  out_port(output, Message, queue);
  void consume(bool ready);
  action(a, "a") {
    input.isReady(1);
    int value := input.dequeue(1);
    output.enqueueDeferredMessages(1, 2, 3);
    Global_to_string(Global:G);
    Release_Mode_to_string(Mode:Read_Only);
    Release_State_to_permission(State:I);
    stallPort(input);
    DPRINTF(HtmMem, "ok");
    DPRINTFN("%d");
    consume(input.dequeue(1));
  }
  transition({I
              S;}, {Load, Store;}, *) { ResourceOnly } { a missing }
  transition(S, Load, *) {}
}
`,
  'ruby/protocol/UsingShared.sm': 'include "Shared.sm"; Shared value; void f() { value.Payload; }\n',
  'ruby/protocol/Updated.sm': 'structure(AbstractCacheEntry) {}\nmachine(MachineType:Updated) {\nstructure(CacheEntry, interface="AbstractCacheEntry", desc="The primary cache") { int Value, desc="<b>value</b>\\nnext line"; int Undocumented; }\nstructure(DirEntry, interface="AbstractCacheEntry", main="FaLsE") { int Directory; }\nstate_declaration(State) { I; }\nenumeration(Event) { Load; }\nint number(), desc="Prototype documentation";\nint number() { return 1; }\naction(a, "a") { cache_entry.Value := number(); DPRINTF(Ruby, "%d", number()); DPRINTFN("%d"); DPRINTF(Missing, "hello"); missing(); int n := APPEND_TRANSITION_COMMENT("x"); }\ntransition(I, Load) { a; }\ntransition(I, Load) { nonexistent; }\n}\n'
})) { const file = path.join(testDir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
const executableDir = path.dirname(executable);
const cliCandidates = process.platform === 'darwin' ? [path.resolve(executableDir, '../Resources/app/out/cli.js')] : [path.join(executableDir, 'resources/app/out/cli.js'), ...fs.readdirSync(executableDir).filter(name => /^[a-f0-9]{10,40}$/i.test(name)).map(name => path.join(executableDir, name, 'resources/app/out/cli.js'))];
const cli = cliCandidates.find(file => fs.existsSync(file));
if (!cli) throw new Error('Cannot locate the installed VS Code CLI module.');
const vsix = packageExtension();
const install = spawnSync(executable, [cli, '--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', vsix, '--force'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
process.stdout.write(install.stdout || ''); process.stderr.write(install.stderr || '');
if (install.status !== 0) throw new Error(`VSIX installation failed (${install.status}): ${install.error || ''}`);
const installed = path.join(extensions, `${manifest.publisher}.${manifest.name}-${manifest.version}`);
if (!fs.existsSync(path.join(installed, 'package.json'))) throw new Error('VS Code did not install the packaged extension at the expected path.');
const env = { ...process.env, SLICC_TEST_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
const reportPath = path.join(root, '.test/vscode-report.json'); if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
const logPath = path.join(testDir, 'host.log'), log = fs.openSync(logPath, 'w');
const child = spawn(executable, [path.join(root, 'examples'), '--user-data-dir', userData, '--extensions-dir', extensions, '--extensionDevelopmentPath=' + installed, '--extensionTestsPath=' + path.join(root, 'test/vscode/run.js'), '--disable-extensions', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--skip-add-to-recently-opened', '--no-sandbox'], { env, windowsHide: true, stdio: ['ignore', log, log] });
const timeout = setTimeout(() => { child.kill(); console.error('VS Code tests timed out after 120 seconds.'); process.exitCode = 1; }, 120000);
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timeout); fs.closeSync(log);
  if (code === 0 && fs.existsSync(reportPath)) { console.log(fs.readFileSync(reportPath, 'utf8')); process.exitCode = 0; }
  else { console.error(fs.readFileSync(logPath, 'utf8').split('\n').slice(-65).join('\n')); console.error(`VS Code host tests failed. Full log: ${logPath}`); process.exitCode = 1; }
});

# SLICC / gem5 Ruby Language Support for VS Code

English | [简体中文](README.zh-CN.md)

**Write gem5 Ruby cache coherence protocols like you write C++.**

Language support for the **SLICC language** used by gem5 Ruby cache-coherence protocols, covering `.sm` and `.slicc` files. Version **0.3.0** aligns with the CLion plugin **1.5.0** feature set in an independent JavaScript implementation. It requires no Java, Python, gem5 build, or npm dependencies.

Original CLion / IntelliJ IDEA plugin repository: [ilo5u/gem5-slicc-plugin](https://github.com/ilo5u/gem5-slicc-plugin).

## Installation and Usage

1. Run `npm run package` in this directory to generate `dist/slicc-0.3.0.vsix`.
2. In the VS Code Extensions view, open the `…` menu and choose **Install from VSIX…**, then select the file. Alternatively, run `code --install-extension dist/slicc-0.3.0.vsix`.
3. Open the full gem5 repository, then open a protocol file under `src/mem/ruby/protocol`. The language mode in the status bar should be **SLICC**.

The bundled `examples/Example.slicc` is a self-contained example for exploring editor features; it is not a runnable gem5 protocol. Press **F5** in this project to launch an Extension Development Host.

## Features

| Feature | VS Code Actions and Behavior |
| --- | --- |
| Syntax and semantic highlighting | SLICC reserved words, attributes, types, machines, functions, actions, fields, enum constants, and implicit variables |
| Context-aware completion | `Ctrl+Space`; after `.`, suggest only the receiver's members, with support for `interface` inheritance, message types, and reference/pointer parameters |
| Protocol indexing | Follow `.slicc` / `include` relationships and `RubySlicc_interfaces.slicc`, distinguishing machine, type, and lexical scopes |
| Definition navigation | `F12` / `Ctrl+Click`, with local-variable shadowing, function overloads, and declarations/definitions across files |
| Bidirectional navigation | From action declarations to transitions; from function definitions or declaration-only functions to calling statements; from field/enum constant declarations to usage statements |
| Related locations | Use **SLICC: Go to Related Transitions / Calls / Usages** from the Command Palette or context menu to view single-line previews of complete statements and jump to the identifier |
| Find references | `Shift+F12`, matching symbol identity and overloads and combining references to function prototypes and definitions |
| Signature help and hover | `Ctrl+Shift+Space` or type `(` / `,` to see overloads and the active parameter, preserving `&` / `*` modifiers |
| Inlay hints | Parameter names and the type at the first use of each implicit `in_msg` / `out_msg` / `tbe` / `cache_entry` / `address` binding |
| Primary cache entry | Resolve implicit `cache_entry` to the visible structure implementing `AbstractCacheEntry`, including CHI's `CacheEntry`; exclude case-insensitive `main="false"` types and defer missing/ambiguous defaults |
| Logical ports | Resolve `in_port` / `out_port` as `InPort` / `OutPort`; use their visible declarations for completion, navigation, references, signature help, return types and member checks |
| Enum defaults and generated helpers | Navigate non-string `EnumName_MemberName` defaults to the declared enum member and enum/state helper calls to their generating declarations |
| Debug output and builtins | Highlight and complete `DPRINTF`, `DPRINTFN`, `APPEND_TRANSITION_COMMENT` and void-returning `stallPort`; suggest project-wide `DebugFlag` / `CompoundFlag` names only in DPRINTF's first argument |
| Attributes | Recognize `block_on`, `format`, `wake_up`, `rsc_stall_handler`, `prot_stall_handler`, `return_by_ref` and `return_by_pointer` alongside existing attributes |
| Format diagnostics | Warn about literal DPRINTF/DPRINTFN argument-count mismatches; retain errors for missing/unknown flags and missing formats; support `%%`, star width/precision and nested-call commas |
| Transition and call diagnostics | Check missing actions and later duplicate state/event pairs in include order, including mixed list separators, wildcard next states and resource blocks; flag definitely missing visible function names |
| Declaration documentation | Show the selected symbol's `desc` on hover, preserving newlines and escaping markup; allow fallback only between matching function prototypes and definitions |
| File and symbol icons | Distinct `.sm` / `.slicc` icons and light/dark declaration badges in the SLICC Symbols view |
| Diagnostics | Unresolved ordinary identifiers, message-scope errors, definite unknown members, function-result assignment/argument type mismatches, and invalid uses of void results |
| External C++ types | From external SLICC type declarations to reachable C++ definitions/aliases, respecting `external_name`, namespaces, Ruby build dependencies, and generated forwarding-header mappings |
| Everyday editing | Outline, `Ctrl+T` symbol search, folding, comment toggling, bracket matching, and automatic bracket closing |

**Go to Declaration** always returns semantic declaration locations. On declaration names, **Go to Definition** provides the bidirectional navigation described above, following the original plugin's behavior.

Implicit `in_msg` in `peek` and `out_msg` in `enqueue` take their types from the second argument of the nearest matching block. Nested blocks inherit surrounding bindings, and explicit parameters/local variables take priority. Shared files can belong to multiple machines; usage discovery searches all calling contexts.

In actions, `cache_entry` uses the unique primary `AbstractCacheEntry` implementation visible in that machine/include scope. Omitted `main` defaults to true; `main="false"` excludes a structure. Navigation, completion, overload inference and inlay hints share this selection. Explicit locals and parameters still take priority, and an ambiguous or missing default never falls back to an unrelated `Entry`.

Logical ports always use `InPort` or `OutPort` as their receiver type; the second declaration argument is the message type. Methods such as `isReady` and `dequeue` resolve through the visible SLICC declarations in `RubySlicc_Types.sm`. These two names also work as ordinary user-defined methods and free functions. Parameters, preceding locals and fields can shadow ports; duplicate ports, ambiguous receiver types and multiple machine owners defer lookup.

Non-string enum defaults resolve within the field's declared enum, including names containing underscores. Generated helpers use the exact generated identifier: global `EnumName_to_string`, machine-local `MachineName_EnumName_to_string`, and state `MachineName_State_to_permission`. Machine-owned enums/states carrying `external` or `primitive` use their type name or `external_name` without the machine prefix. Explicit functions and variables take priority; ambiguous or incomplete declarations defer lookup.

Transition state, event and action lists accept whitespace, comma or semicolon separators and optional trailing separators. The third argument may be `*`. A single brace block contains actions, even when empty or semicolon-free; with two blocks, the first contains resources. An unterminated action retains its syntax error while later declarations remain available for outline and navigation.

The **SLICC Symbols** view in Explorer shows the current file with the original light/dark declaration badges. To enable distinct blue `SM` and purple `H` file icons, run **Preferences: File Icon Theme** and select **SLICC (gem5 Ruby)**. This optional theme uses generic icons for other files and folders. Native Outline and completion lists retain VS Code's standard symbol icons; the active file icon theme can override the default language icon.

## Configuration

Search for `SLICC` in Settings. Common options:

```json
{
  "slicc.inlayHints.parameterNames": true,
  "slicc.inlayHints.implicitTypes": true,
  "slicc.diagnostics.members": true,
  "slicc.diagnostics.functionResults": true,
  "slicc.diagnostics.externalTypes": true,
  "slicc.diagnostics.printf": true,
  "slicc.diagnostics.transitions": true,
  "slicc.diagnostics.calls": true,
  "slicc.navigation.maxStatementLength": 160,
  "slicc.index.includePaths": []
}
```

`includePaths` accepts workspace-relative paths, absolute paths, or remote directory URIs. Indexing excludes `.git`, `node_modules`, `build`, `dist`, and `.venv` by default; adjust `slicc.index.exclude` to change this. New and modified files update the index automatically. You can also run **SLICC: Rebuild Workspace Index** manually.

External C++ type lookup requires a Ruby root containing `Kconfig`, `SConscript`, and `protocol/`. It follows supported literal `Source` / `MakeInclude` / `SLICC_INCLUDES` entries and C++ `#include` paths. Opening the full gem5 repository makes common headers outside the Ruby subtree available. Missing source context produces a warning; a readable context without a matching definition produces an error.

For unqualified machine-owned external types, lookup prefers the unique `gem5::ruby::<protocol>` namespace, then shared `gem5::ruby`. Non-machine types prefer shared Ruby first. Protocol ownership follows literal `.slicc` declarations and includes, matched to Kconfig `RUBY_PROTOCOL_*` suffixes or whitespace-normalized `bool` prompts. Only includes inside a machine propagate machine ownership. Unknown or conflicting protocol ownership retains shared lookup and warns if that also misses; lookup never searches other protocols. Qualified overrides retain their explicit namespace.

Debug flag completion reads literal `DebugFlag` and `CompoundFlag` declarations throughout the current project or the related gem5 checkout, including non-Ruby scripts such as `src/mem/SConscript` (`HtmMem`). Discovery is independent of the C++ build graph and does not require Kconfig registration. Known names remain available when the project boundary or source discovery is incomplete, while unknown-flag errors require complete discovery. `DPRINTFN` takes a format string without a flag. Script and unsaved-document changes refresh the cached names. Only format-count mismatches are warnings; flag errors and missing format strings remain errors. `APPEND_TRANSITION_COMMENT` has no format-count check.

## Development and Verification

Requires Node.js 18 or later. There is no need to run `npm install`.

```sh
npm run check
npm test
npm run test:corpus -- "<path-to-reference-repository>"
npm run package
npm run test:vscode
```

`test:corpus` reads the Ruby source snapshot at HEAD in the specified repository and checks real protocol parsing, includes, navigation, inlay hints, external C++ type mappings, debug flags, and the actual primary entries in MI_example, CHI and MOESI_hammer. Append a Git ref, such as `v1.5.0` for the original plugin repository, to pin a release snapshot. It also checks malformed-action recovery, all nine port methods, enum defaults, CHI's `MN_TBEStorage` namespace, and duplicate detection in CHI's 226 transitions using an in-memory edit. Detailed results are written to `.test/corpus-report.json`. It supports `ruby/` in the original plugin repository or `src/mem/ruby/` in a gem5 repository, and does not modify the source repository. A Ruby-only snapshot provides partial debug-flag completion; non-Ruby declarations require the full project.

`test:vscode` uses a locally installed VS Code. It installs the newly generated VSIX into isolated user-data and extension directories under `.test/vscode/`, then verifies features in a real Extension Host. Set `VSCODE_EXECUTABLE` to override the executable path. Results are written to `.test/vscode-report.json`. Ordinary unit tests do not launch VS Code.

See [docs/architecture.md](docs/architecture.md) for the architecture and feature mapping. The local VSIX can be installed directly. Before publishing to the Marketplace, set `publisher` in `package.json` to a publisher ID you own and follow the official [vsce publishing workflow](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

Keep this file and [README.zh-CN.md](README.zh-CN.md) synchronized when changing installation steps, features, settings, verification commands, or analysis limits.

## Analysis Limits

As with the original plugin, rename refactoring, full code formatting, C++ member/call resolution, and complete compiler type checking are not provided. Unknown or incomplete types, interface cycles, ambiguous declarations, complex operations, and indexed expressions defer the relevant type diagnostics. Member-name diagnostics cover only receivers that can be reliably identified. Function-result checks do not validate every ordinary argument or function-body `return` type, and do not model C++ implicit conversions.

Debug format checks validate counts, not argument types; dynamic or unsupported formats and incomplete calls defer those checks. Missing-function diagnostics check names, not argument compatibility. Transition diagnostics require an unambiguous, complete machine/include expansion and apply state/event-set overlaps only to later transitions. A malformed file retains its primary syntax errors while semantic cascades are deferred.

The C++ dependency graph statically combines conditional branches without executing Kconfig, SCons, a preprocessor, or a compiler. Computed paths, macro-generated definitions, and complex aliases may not resolve. The extension supports desktop VS Code and workspace extension hosts in Remote SSH / WSL; it is not a browser Web extension.

## License

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). The gem5 regression corpus is read only from a user-specified local repository and is not included in the extension.

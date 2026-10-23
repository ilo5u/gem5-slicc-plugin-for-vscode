# Architecture and CLion feature mapping

The extension runs as a VS Code workspace extension. There is no external language
server, compiler, Python interpreter, build process, telemetry or runtime package
dependency. The core modules accept source strings and URI keys and are testable
without a VS Code process.

## Source pipeline

`core/lexer.js` → `core/parser.js` → `core/index.js` → `core/analysis.js`

The lexer preserves UTF-16 source offsets and recognizes comments, strings,
attributes, SLICC keywords, C++ scoped names and operators. The parser produces
declarations, lexical scopes, message bindings, include edges, statement ranges,
transition roles and matched delimiters. It tolerates unfinished editor buffers.

The workspace index maintains protocol and machine include closures and the nearest
`RubySlicc_interfaces.slicc` global scope. A file can belong to several machine
closures. Machine fields require a unique owning machine, while shared action and
function references can link back to every calling machine. Machine-field
references scan only the owning machine's include closure and compare resolved
declaration identity before deduplicating statements; all actual targets remain
available. Only includes issued inside a machine start that machine's closure;
transitive traversal excludes includes owned by nested machines. Global and
outside-machine includes retain their own scopes. Machine members, free
functions and type members have separate namespaces.

An analysis session shares resolution, expression, call and inherited-member
caches. Locals are visible after declaration within their lexical block; parameters
and machine/type fields participate in shadowing. Message bindings come from the
nearest enclosing matching `peek` or `enqueue` block. Explicit declarations take
priority. Nominal SLICC types and supported `interface` relationships drive
overload selection without using an assignment's desired return type.

Implicit action `cache_entry` selects the unique visible structure whose direct
`interface` is `AbstractCacheEntry`. `main` defaults to true; case-insensitive
`main="false"` excludes a candidate. Selection is cached in the workspace scope,
shared across navigation, completion, expression inference and hints, and deferred
for missing, ambiguous or incomplete owners. There is no literal `Entry` fallback.

Logical ports resolve through a unique visible declaration and have fixed `InPort`
or `OutPort` types. The message argument never becomes the port receiver type.
Their methods reuse the normal member/call/type pipeline. Explicit parameters,
preceding locals and fields take priority. Duplicate ports or receiver types and
multiple machine owners defer resolution. `isReady` and `dequeue` are ordinary
identifiers; neither has unconditional builtin completion or result inference.

Parser-recorded enum defaults preserve their attribute owner. The resolver checks
that owner's declared enum and exact member/`EnumName_MemberName` alias, without
splitting underscores or borrowing unrelated constants. Generated enum/state
helpers resolve to the unique generating declaration using gem5's machine prefix
and `external`/`primitive` naming rules. Explicit variables/functions retain
priority. References include these aliases and helper spellings, and generated
calls receive function semantic tokens.

`core/diagnostics.js` checks ordinary identifiers, message scopes, complete simple
member receivers, and definite function-result mismatches. Unknown expressions
defer checks. The legacy `NetDest`, `Set` and reverse-interface exceptions are
limited to assignments. `core/hints.js` reuses the same resolver for parameter
names and the first use of each implicit binding.

`core/transitions.js` checks action names and duplicate expanded state/event pairs
in source/include expansion order. It caches results against the index revision
and defers cyclic, missing and ambiguous contexts. Transition lists accept mixed
whitespace/comma/semicolon separators and trailing separators; the third state
argument supports `*`. A following second block distinguishes resources from
actions. Parser recovery stops at a new declaration after a malformed action,
preserving the syntax error and later outline/navigation nodes. `core/call-diagnostics.js`
checks visible free and supported scoped function names without treating
argument mismatches as missing functions. `core/printf.js` counts literal format
arguments, respecting escaped percent signs, star widths/precisions and nested
calls. Only format-count mismatches are warnings; missing formats and flag errors
remain errors. Output builtins and `stallPort` have void results in inference.

`core/debug-flags.js` collects literal `DebugFlag` and `CompoundFlag` declarations
from project-wide `SConscript`/`SConsopts` files, or a related gem5 checkout found
through `SConstruct`. This scan includes non-Ruby sources and is independent of
the C++ graph and Kconfig. Cached names feed DPRINTF completion; unknown-flag
errors require a known project boundary and complete discovery. A Ruby-only
fallback retains completion with incomplete-source deferral. Directory/script
dependencies and unsaved edits invalidate the scan; build scripts are never run.

## Editor integration

`workspace.js` discovers and loads files with `workspace.fs`, overlays unsaved
documents, follows extra include paths, and invalidates indexes on edits, file
events, configuration changes and workspace-folder changes. Diagnostics are
debounced and reject cancelled or stale document versions. Refresh events update
semantic tokens and inlay hints after indexing.

`providers.js` registers native VS Code providers for completion, definition,
declaration, implementation, type definition, references, hover, signature help,
document/workspace symbols, folding, semantic tokens and inlay hints. Definition
navigation from selected declarations reverses into actual usage statements;
semantic references still point to declarations. A related-usage Quick Pick shows
collapsed statement previews and preserves the actual identifier offset.

The TextMate grammar supplies immediate lexical highlighting before indexing.
The language configuration supplies comments, bracket pairs, indentation and
automatic bracket/quote closing.

Hover uses the selected declaration's own `desc`, safely escaping markup and
preserving newlines. Fallback is restricted to matching function prototypes and
definitions; conflicting descriptions and ambiguous usages defer that content.

`.sm` uses the `slicc` language ID and `.slicc` uses `slicc-list`, each with
distinct default light/dark file icons. `languages.js` supplies a shared provider
selector and document predicate so both retain the same language services,
buffer tracking and diagnostics. The include-list TextMate grammar delegates to
`source.slicc`. Both language IDs have editor defaults and semantic token scopes.
The optional SLICC file icon theme also differentiates the two extensions; the
default language icons remain subject to the user's active theme. `symbols-view.js`
provides the SLICC Symbols tree with the original declaration SVG badges and
dedicated light/dark paths. VS Code's native Outline retains its SymbolKind
icons because its document-symbol provider does not accept custom SVG icons.

## External C++ types

`core/build-scope.js` locates the related Ruby root using its Kconfig/SConscript
layout, follows literal Kconfig paths and scans related build scripts. Literal
`Source`, `MakeInclude` and `SLICC_INCLUDES` entries seed a transitive C++ include
graph. Generated protocol forwarding headers map back to their source headers.
`core/cpp.js` recognizes supported namespaced class/struct/enum/union definitions
and aliases, discarding forward declarations. Results are cached independently
from SLICC symbol lookup and invalidated on C++/build source edits.

`external_name`, namespace qualification, templates, port mappings, scalar/std
exemptions, missing-definition errors and missing-context warnings follow the
original plugin's design. Semantic SLICC type references continue pointing to
SLICC declarations; the C++ jump is performed on the external declaration name.

`core/protocols.js` separately caches protocol ownership from Kconfig
`RUBY_PROTOCOL_*` suffixes, normalized bool prompts and literal `.slicc` include
closures. Parsed files live in a workspace-owned map and are reused by text
identity. Only machine-body include edges propagate machine ownership. An
unqualified machine type prefers `gem5::ruby::<protocol>::Name`, then shared
`gem5::ruby::Name`; a non-machine type tries shared first. Unknown/conflicting
machine ownership warns after shared fallback misses and never searches unrelated
protocols. Qualified overrides and the `external_type` gem5 fallback retain their
existing behavior. SLICC edits invalidate this lightweight graph without
rebuilding the cached reachable C++ definitions; C++/build/root changes invalidate
both graphs.

## CLion to VS Code mapping

| CLion component | VS Code implementation |
| --- | --- |
| Lexer / Parser / PSI | `core/lexer.js`, `core/parser.js` |
| ProtocolIndex / FileSymbols | `core/index.js`, parsed declaration lists |
| GotoDeclaration / Reference / FunctionNavigation / MemberNavigation | `core/analysis.js`, native definition/reference providers, related-usage command |
| MessageScope / ExpressionTypes | shared implicit bindings and expression inference in `core/analysis.js` |
| Ports / EnumDefaults / GeneratedFunctions | scope-aware port bindings, attribute defaults and generated identifiers in `core/analysis.js` |
| Annotator / MemberDiagnostics / TypeDiagnostics | `core/diagnostics.js`, DiagnosticCollection, semantic token provider |
| CompletionContributor / ParameterInfo / TypedHandler | completion and signature-help providers with trigger characters |
| InlayHints / InlayPresentation | `core/hints.js`, native InlayHint provider, independent settings |
| ExternalTypeNavigation / RubyBuildScope / RubyProtocols / CppTypes | `core/build-scope.js`, `core/protocols.js`, `core/cpp.js` |
| StructureView / GotoSymbol / FoldingBuilder | outline, workspace symbols, folding provider |
| BraceMatcher / Commenter | `language-configuration.json` |
| PrintfDiagnostics / DebugFlags | `core/printf.js`, `core/debug-flags.js`, first-argument flag completion |
| TransitionDiagnostics / CallDiagnostics | `core/transitions.js`, `core/call-diagnostics.js` |
| DocumentationProvider | `Analysis.description`, escaped hover/completion documentation |
| File and declaration icons | optional `icons/slicc-icon-theme.json`, `symbols-view.js` |

## Validation

`test/core.test.js`, `test/update.test.js`, `test/release150.test.js` and
`test/release160.test.js` cover scope isolation, shadowing, messages, modifiers,
overloads, interface inheritance, conservative diagnostics, hints, references,
reverse navigation, logical ports, enum defaults/helpers, recovery, protocol
ownership and independent caches, including ambiguous and nested machine-member
ownership and all 45 statements in a larger navigation fixture. The corpus script
reads a local Git snapshot and exercises real MI/MESI/MOESI/CHI protocols, including
all eight CHI `directory` usage statements. The VS Code host runner
first packages and installs the actual VSIX into an isolated test extension
directory, then executes native provider commands against that installed copy.
Neither test workflow modifies the CLion source repository or the user's installed
extensions.

The custom VSIX packager writes ZIP/OPC manifests with Node's standard library.
`npm run package` needs no downloaded tools; Marketplace publishing can use the
official `@vscode/vsce` CLI when available.

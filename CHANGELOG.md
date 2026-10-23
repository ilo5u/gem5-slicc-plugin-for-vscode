# Changelog

## 0.4.0 — 2026-10-23

- Align with JetBrains plugin 1.6.0, tag `v1.6.0`, commit `a86cd4254c6ec0294fd65c11c5c1999076c604d2`.
- Find machine member-variable usages within the owning machine and its transitive includes, including CHI's `directory`. Retain declaration identity, parameter/local shadowing, statement deduplication and all results without truncation.
- Defer machine-field resolution in ambiguously shared include files and prevent nested machines' include closures from leaking into their outer callers. Preserve structure-field and enum navigation, semantic declaration targets and ordinary references.
- Set the VS Code extension's author explicitly to `chengxin`, retain publisher `chengxin`, and preserve the existing logo, bilingual guides and acknowledgments.
- Add regression coverage for ownership, shadowing, includes, native navigation and all eight real CHI `directory` usage statements. Retain the 0.3.2 default-icon fix.

## 0.3.2 — 2026-10-22

- Fix `.slicc` files displaying the `.sm` default icon. Register SLICC Include List separately with `slicc.svg` / `slicc_dark.svg`, while `.sm` retains `sm.svg` / `sm_dark.svg`.
- Share the existing language providers, indexing, unsaved-edit handling, symbols view, commands and editor defaults across both file types.
- Verify default icon registration, include-list completion/navigation and unsaved protocol edits in the installed-VSIX host tests.

## 0.3.1 — 2026-10-22

- Add the VS Code extension's GitHub repository and issue tracker to the English and Chinese README files.
- Set explicit homepage and issue-tracker metadata alongside the repository so VS Code and the Marketplace can display these resource links.
- Include the same resource links in the offline VSIX manifest.

## 0.3.0 — 2026-10-22

- Align with JetBrains plugin 1.5.0, tag `v1.5.0`, commit `e54aa1b2986c6975cb87469c27d0bd2e6126c998`.
- Accept whitespace/comma/semicolon transition lists, trailing separators, and wildcard next states. Separate optional resources from actions and retain checks for empty or semicolon-free action blocks.
- Recover later declarations after an unterminated action; the real MOESI region-directory source retains its syntax error while restoring all 60 actions, 98 transitions and 14 write-back usage targets.
- Resolve logical ports as fixed `InPort` / `OutPort` receivers through visible SLICC method declarations. Share completion, references, signature help, inference and diagnostics, preserving shadowing and ambiguity guards. Treat `isReady` / `dequeue` as ordinary identifiers and functions.
- Navigate non-string enum defaults to the exact declared enum member, including underscore-containing names and reverse references. Resolve generated enum/state helper calls with gem5's type identifiers, explicit-declaration priority and function highlighting.
- Recognize `wake_up`, `rsc_stall_handler`, `prot_stall_handler`, `return_by_ref` and void-returning `stallPort` across lexer, grammar, completion and inference.
- Discover debug flags across the current project or gem5 checkout, including non-Ruby `HtmMem`, independently of Kconfig and reachable C++ sources. Retain known completion and defer unknown-flag errors for unavailable/incomplete discovery.
- Prefer the unique protocol namespace for machine-owned external C++ types, matching Kconfig suffixes/prompt aliases and literal `.slicc` include closures. Preserve shared fallback, exact qualified names, machine-only include ownership and warnings for unknown/conflicting protocol context. Cache protocol parsing separately from the C++ graph and refresh unsaved edits.
- Change only DPRINTF/DPRINTFN format-count mismatches to warnings; flag and missing-format errors retain their severity.
- Synchronize English/Chinese documentation and extend core, real-corpus and installed-VSIX host verification. Preserve local-file exclusions in Git and VSIX packaging.

- Add a 128×128 circular SLICC logo with a blue/purple gradient, white wordmark and transparent background. Include PNG/SVG assets and use the PNG as the extension icon.

## 0.2.0 — 2026-10-21

- Align with local JetBrains plugin 1.4.0, commit `49089147f2db1a80201d3d97067e002eb59c6863`.
- Resolve implicit `cache_entry` through the visible primary structure implementing `AbstractCacheEntry`; honor case-insensitive `main="false"`, explicit shadowing, and ambiguous/missing scopes. Share this type across navigation, completion, result inference and hints.
- Highlight and complete `block_on`, `format`, `DPRINTFN` and `APPEND_TRANSITION_COMMENT`; infer output builtins as void results.
- Complete literal Ruby `DebugFlag` / `CompoundFlag` names in DPRINTF's first argument. Check missing/unknown flags only when the related source graph is complete.
- Validate literal DPRINTF/DPRINTFN format argument counts, including escaped percent signs and star width/precision, preserving nested-call commas.
- Check missing transition actions and duplicate expanded state/event pairs in machine/include expansion order; defer incomplete and ambiguous contexts.
- Report definitely missing visible free and supported scoped function names without confusing argument mismatches with absent functions.
- Display each symbol's own `desc`, with safe markup handling, preserved newlines and fallback between matching function prototypes/definitions.
- Reuse all 16 original light/dark SVG assets. Add the optional SLICC file icon theme and a SLICC Symbols view with declaration badges; retain native VS Code Outline symbol icons.
- Synchronize English/Chinese README files and extend core, real-protocol and installed-VSIX host verification.

## 0.1.0 — 2026-10-21

- Initial VS Code implementation of the CLion SLICC plugin 1.3.0 feature set.
- Syntax and semantic highlighting, machine/include/global indexing and lexical scopes.
- Type-aware completion, overload-aware navigation, references and reverse usage discovery.
- Signature help, hover, outline, symbol search, folding, comments and bracket configuration.
- Independent parameter-name and implicit-type inlay hints.
- Conservative member, function-result and scoped-message diagnostics.
- External SLICC types to reachable C++ definitions and aliases through Ruby build dependencies.
- Dependency-free tests and VSIX packaging, local VS Code host tests and gem5 corpus verification.

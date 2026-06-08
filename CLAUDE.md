# Implementation Notes for This Fork

## Architecture overview

- `lib/doctype.js` — maps language IDs and file extensions to parser instances
- `lib/parser.js` — base parser class; defines global regexes `SPELLRIGHT_LEXEM_BUILD` / `SPELLRIGHT_LEXEM_SPELL` and `replaceAt` utility
- `lib/parsers/*.js` — one file per parser (plaintext, markdown, latex, code, xml, typst)
- `lib/bindings.js` — loads the platform-specific native `spellchecker.node` from `lib/bin/`; falls back to Hunspell when the OS spellchecker is unavailable
- `lib/bin/` — prebuilt native bindings, one file per (platform, runtime ABI, arch) tuple; loader `glob`s for `spellchecker*<arch>*.node` and tries each until one `require()`s without throwing
- `src/spellright.js` — main extension logic: spell check loop, diagnostics, code actions, settings

Each parser implements three methods:
- `_filter_global(document, text, options)` — called once on the full document text; replaces filtered content with spaces (preserving newlines so line/column positions stay valid)
- `_filter_line(document, text, options)` — called per line just before token extraction
- `_parse(...)` — walks the (already filtered) text character by character, calls `checkAndMarkCallback` for each token

The key invariant for both filter methods: **replacements must preserve document geometry**. Non-newline characters are replaced with spaces using `match[0].replace(/(?:[^\r\n]|\r(?!\n))/g, ' ')` or `' '.repeat(match[0].length)`.

## Typst parser (`lib/parsers/typst.js`)

Registered in `lib/doctype.js` under language ID `typst` and extension `.typ`. Also added to the default `documentTypes` list in `package.json`.

The parser consumes Tinymist's LSP semantic tokens to determine spell-checkable regions, instead of guessing via regex. Tinymist classifies every span; we allowlist a small set of semantic token types as "natural language" and blank everything else.

### `_filter_global` (whole-document filter)

1. Apply the user's `ignoreRegExpsMap` (no change from upstream).
2. Look up the document URI in `SEMANTIC_CACHE` (a module-level `Map`). If the entry is fresh — i.e. not `'pending'` or `'unavailable'`, and `entry.version === document.version` — run the **semantic filter** and return.
3. Otherwise fall back to a regex pass (math `$...$`, `#identifier`, `@reference`, ` ```...``` `, `` `...` ``). The fallback exists so autocorrect / diff spell-check have *some* misspelled-word diagnostics during the ~200 ms debounce window between a keystroke and the next semantic refresh. Less accurate than the semantic path; the alternative (blank everything) silently disables autocorrect mid-typing.

The semantic filter walks the delta-encoded LSP token array and marks spellable character positions:

- **Always spellable**: `text`, `heading`, `term` (Tinymist's `Heading`, `ListTerm`, and the leaf-default `Text` token type)
- **Gated**: `comment` (default on, opt-out via `spellright.typst.spellCheckComments`), `string` (default off, opt-in via `spellright.typst.spellCheckStrings`)
- **Math modifier**: any token whose modifier mask includes the `math` bit is skipped — covers leaf `text` tokens inside `$...$` regions
- **Container override types**: `raw`, `link`, `ref`, `label` — clear any spellable bit inside these ranges (Tinymist emits the parent token, but child leaves still get tokenized as `Text`, so the override has to win)
- **Raw-block text scan**: Tinymist (current version) does *not* emit `raw` tokens for backtick spans on this corpus — block raw content gets tagged as plain `text` and the fences as nothing useful. So after the token walk, two regexes ` ```...``` ` and `` `...` `` clear those ranges. This isn't a fallback path; it's a targeted supplement for the one construct Tinymist's semantic output doesn't cover.

### `_filter_line` (per-line filter)

Strips `#import` lines (whole-line blank), URLs, and bare email addresses (defense-in-depth for plain-text mentions inside otherwise-spellable spans like paragraphs). The URL/email regexes match the plaintext parser. The `#import` filter is mostly there for the regex-fallback path; with fresh semantic tokens the line is already fully classified.

### `_parse`

Identical structure to the plaintext parser. Tokens are tagged `parser: 'typst'` for per-parser notification class configuration via `spellright.notificationClassByParser`.

### `SEMANTIC_CACHE` lifecycle (managed by `src/spellright.js`)

The cache is a `Map<uriString, 'pending' | 'unavailable' | { data: Uint32Array, legend, version }>` exported from `lib/parsers/typst.js`. Three methods on the SpellRight prototype manage it:

- `refreshTypstSemanticTokens(document)` — async; fires both `vscode.executeDocumentSemanticTokensProvider` (modern ID) and `vscode.provideDocumentSemanticTokens` (legacy alias) and the matching legend command, falling through on errors. Stores the decoded result keyed by URI with `version = document.version` *at request time*. On success, calls `doInitiateSpellCheck(document, true)` to re-run the spell pass with the now-fresh filter. Has an early-out guard so calling it on a fresh-or-pending entry is a no-op (lets us call it from `doInitiateSpellCheck` without infinite recursion).
- `scheduleTypstSemanticRefresh(document)` — 200 ms debounce per URI; called on every `onDidChangeTextDocument` so rapid typing doesn't hammer the LSP.
- `discardTypstSemanticState(document)` — called on `onDidCloseTextDocument`; deletes the cache entry and clears any pending refresh timer.

The fetch is also kicked off from inside `doInitiateSpellCheck` for any typst document. This matters at window-reload time: VS Code restores documents *before* `onDidOpenTextDocument` listeners attach, so the open handler misses them — but the visible-bootstrap path (`doInitiateSpellCheckVisible`) does call `doInitiateSpellCheck`, so piggy-backing the fetch there guarantees coverage.

### Settings (`spellright.typst.*`)

- `spellright.typst.useSemanticTokens` — boolean, default `true`. When `false`, the parser skips Tinymist entirely (no LSP request fires) and uses the regex pass exclusively. Useful when Tinymist isn't installed, or to avoid the LSP round-trip on big files.
- `spellright.typst.spellCheckComments` — boolean, default `true`. When false, comments are skipped (semantic path only — regex fallback always strips `// ...` style comments via the `#identifier` pattern not at all, so this setting is moot when `useSemanticTokens=false`).
- `spellright.typst.spellCheckStrings` — boolean, default `false`. When true, string literal contents are checked (semantic path only).

To disable typst spell-check entirely, remove `typst` from `spellright.documentTypes`.

### Parser options plumbing

`SpellRight.prototype._getParserOptions()` is the single source of truth for the options object passed to `parseForCommands` / `spellCheckRange` (5 call sites in `src/spellright.js`). It carries `ignoreRegExpsMap`, `latexSpellParameters`, `typstUseSemanticTokens`, and the two typst-spellcheck booleans. The flag is also baked into the `FILTERED_CACHE` fingerprint so toggling it invalidates memoized output.

## Autocorrect (`src/spellright.js`)

Added at the end of `SpellRight.prototype.doDiffSpellCheck`, after diagnostics are committed to `this.diagnosticCollection`.

### How it works

1. Checks `settings.autoCorrect` is enabled
2. Checks the change was a single word-boundary character: `/[ \t,\.!?]/`
3. Scans `diagnostics` for one with `source === 'spelling'` whose range ends exactly at the typed position (`d.range.end.character === change.range.start.character` on the same line) — handled by the `_findAndFix` helper
4. If found, calls `bindings.getCorrectionsForMisspelling(word)` with the language from `d['language']` and applies `suggestions[0]` via `editor.edit()` — this triggers another `doDiffSpellCheck` which clears the diagnostic since the word is now correct

The fix is a normal undoable edit. The diagnostic flashes briefly before the replacement fires.

### Period fallback

`SPELLRIGHT_LEXEM_BUILD` (in `lib/parser.js`) treats `.` as **part of a word**, not a boundary, so abbreviations like "U.S.A." stay as one token. As a side effect, typing `.` after a misspelled word like "helo" produces the merged token `"helo."`, and the parser's mid-edit guard (`echaracter == colnumber + (token.length - 1)`) skips it — no diagnostic is created and the diagnostic-search above finds nothing.

The fallback: when the typed character is `.` and the diagnostic search misses, we re-run `_parser.spellCheckRange()` on just the affected line into a temporary diagnostics array, but with `echaracter = _col + 1` so the mid-edit guard misses. The parser's `splitByOtherWhite` then strips the trailing period and emits a sub-diagnostic at `[wordStart, _col)`. We re-run `_findAndFix` on the temp array and apply the suggestion.

Re-running through the parser (rather than walking the line text directly) preserves filter behavior — typing `.` after a misspelled word inside a markdown code block, typst math, or LaTeX command will not autocorrect, because the parser's filters blank those regions before tokenization.

### Setting

`spellright.autoCorrect` — boolean, default `false`, added to `package.json` `contributes.configuration.properties`.

## Workspace dictionary path resolution

`getWorkspaceDictionaryPathInfo(uri)` (added) returns `{path, reason?}`. The previous `getWorkspaceDictionaryPath()` returned `null` silently in every failure mode, which led to:
- `addWordToDictionary('')` called with empty filename → `fs.openSync('', 'w')` throws `ENOENT: ...open ''`
- a generic "file is not part of a workspace folder" warning that didn't explain whether the issue was no-workspace, wrong-scheme, mkdir-permissions, etc.

The new function:
1. Accepts an optional URI (used by the code-action path so we use the document the action targeted, not `activeTextEditor` which can be elsewhere).
2. Falls back to `vscode.window.activeTextEditor.document.uri` only when no URI is passed.
3. Returns a structured failure reason on every miss (no folder, mkdir failed, …) which is surfaced verbatim in the warning toast.

`getWorkspaceDictionaryPath(uri)` is kept as a thin wrapper returning just the path, for callers that don't care about the reason.

`addWordToDictionary` also has a defense-in-depth `if (!filename) return;` guard so any future caller that forgets the path check doesn't crash with ENOENT on empty path.

**Important — do not gate on URI scheme.** An earlier attempt rejected `scheme !== 'file'`, which broke Remote-WSL/Remote-SSH where every URI uses scheme `vscode-remote`. The fs operations are fine when the extension host runs on the remote side (see "Remote/WSL installation" below); the only schemes worth rejecting would be `untitled`, but `getWorkspaceFolder()` returns undefined for those anyway and we surface a useful message.

## Remote/WSL installation (`extensionKind`)

`package.json` declares `"extensionKind": ["workspace", "ui"]`. This is the critical setting for Remote-WSL / Remote-SSH / Remote-Containers users.

- **`"ui"` only** (the original setting): forces the extension to run on the local machine (Windows when using WSL). The extension host then resolves `folder.uri.fsPath` of a `vscode-remote://wsl+ubuntu/home/eric/proj` URI to `/home/eric/proj`, which Windows-side `path.join` produces with backslashes (`\home\eric\proj\.vscode`) and Windows-side `fs.mkdirSync` resolves against `C:\` — yielding `C:\home\eric\proj\.vscode` and ENOENT.
- **`"workspace"` first**: lets VS Code install the extension on the same side the workspace lives on (WSL when WSL, SSH host when SSH). Filesystem ops then run with native paths.
- **`"workspace", "ui"`** as the array: prefers workspace, falls back to UI for purely local use (no remote).

After changing this and rebuilding the VSIX, the user must explicitly install the new VSIX **on the WSL side** — the Extensions panel shows separate "Local" and "WSL: Ubuntu" install buttons. Verify with `Developer: Show Running Extensions` — the entry should show kind `Workspace`.

## Native bindings (`lib/bin/`)

The `spellchecker.node` is platform- and runtime-ABI-specific. `lib/bindings.js` loads it via:

```js
const nodeFiles = glob.globSync(`bin/${baseName}*${process.arch}*.node`, { cwd: __dirname });
```

…then `require()`s each match until one succeeds. Each binary embeds a `NODE_MODULE_VERSION` (the V8/Node ABI version) and Node refuses to load a mismatched one.

### Runtime ABIs in this fork

`lib/bin/` ships:

| File | Built against | NODE_MODULE_VERSION | Where it's used |
|---|---|---|---|
| `spellchecker-win32-{34.2.0,35.5.1,37.2.3,39.2.3}-x64.node` | Electron 34 / 35 / 37 / 39 | 130 / 133 / 136 / 140 | Windows VS Code GUI |
| `spellchecker-macos-{35.5.1,37.2.3,39.2.3}-{x64,arm64}.node` | same Electron versions | same | macOS VS Code GUI |
| `spellchecker-linux-{35.5.1,37.2.3,39.2.3}-{x64,ia32}.node` | same Electron versions | same | Linux VS Code GUI |
| `spellchecker-linux-node{22.22.1,24.15.0}-x64.node` | **Node 22.22.1 / 24.15.0 (stock Node)** | **127 / 137** | **VS Code Server** (Remote-WSL, Remote-SSH) — extension host runs on `~/.vscode-server/bin/<hash>/node`, NOT Electron |

The Node-server binary is the one the original upstream is missing. Without one matching the server's ABI, `spellright` activates on the local Windows side fine but silently fails on the WSL side (every `require()` in the loader's loop throws `NODE_MODULE_VERSION mismatch`), making `bindings.Spellchecker` undefined and aborting activation — which presents as commands like `spellright.selectDictionary` being "not found", no diagnostics, and no status-bar item. Each time VS Code Server bumps its bundled Node (e.g. 22 → 24), a new binary must be built for the new ABI; old ones stay as fallback.

### Rebuilding the Node-server binary

When VS Code Server ships a new Node version (the version is whatever `~/.vscode-server/bin/<latest-hash>/node --version` reports), rebuild against the new target:

```bash
cd lib/bin/node-spellchecker
npx node-gyp rebuild --target=<NODE_VERSION> --arch=x64
cp build/Release/spellchecker.node ../spellchecker-linux-node<NODE_VERSION>-x64.node
```

**`nan` version gotcha:** Node 24's V8 removed `v8::FunctionCallbackInfo::Holder()`, which older `nan` (≤ 2.19, the version hoisted at the repo root) still calls — the build fails with `'…FunctionCallbackInfo<v8::Value>' has no member named 'Holder'`. `node-spellchecker`'s own `package.json` pins `nan: ^2.27.0`; ensure that resolves locally (`cd lib/bin/node-spellchecker && npm install`) before building, since `binding.gyp` locates nan via `node -e "require('nan')"` from that cwd and would otherwise pick up the stale root copy.

Old binaries can stay in `lib/bin/` — the loader skips ABI mismatches and tries the next. To check which one VS Code Server actually picks:

```bash
~/.vscode-server/bin/*/node --version    # what to target
~/.vscode-server/bin/*/node -e 'console.log(process.versions.modules)'  # NODE_MODULE_VERSION
```

`build-linux.sh` documents the current target.

### Rebuilding the Electron-side binaries

Same script (`build-linux.sh`, `build-windows.cmd`, `build-macos-*.sh`) but with `--dist-url=https://electronjs.org/headers` and the matching Electron `--target=<X.Y.Z>`. Update when VS Code's main GUI ships a new Electron version.

## Hunspell dictionaries

On Linux/macOS the spellchecker uses Hunspell. The extension reads `.dic`/`.aff` pairs from `~/.config/<appName>/Dictionaries/` (Linux), where `<appName>` is `vscode.env.appName.replace("Visual Studio ", "")` — typically `Code` or `Code - Insiders`. The fork does **not** bundle dictionaries; users install them themselves.

On Ubuntu/WSL:

```bash
sudo apt install hunspell-en-us hunspell-en-gb        # or other locales
mkdir -p ~/.config/Code/Dictionaries
cp /usr/share/hunspell/*.aff /usr/share/hunspell/*.dic ~/.config/Code/Dictionaries/
```

Reload the VS Code window. `SpellRight: Select Dictionary` should now list the installed locales.

If `Select Dictionary` shows none, check:
- `ls ~/.config/Code/Dictionaries` lists `<lang>.dic` and `<lang>.aff` pairs (both files are required for the language to appear)
- the path matches the variant of VS Code in use — Insiders → `Code - Insiders`, Cursor → `Cursor`, etc.

## Building and installing

### Build

```bash
# From /home/eric/projects/vscode-spellright
vsce package --no-git-tag-version --allow-missing-repository
```

This produces `spellright-local-3.0.148.vsix` in the project root.

### Install via CLI (preferred)

```bash
code --install-extension ./spellright-local-3.0.148.vsix --force
```

- The `code` binary on `$PATH` from inside the WSL shell is `~/.vscode-server/bin/<hash>/bin/remote-cli/code` — running it installs on the **WSL side** automatically (output: "Installing extensions on WSL: Ubuntu..."). This is the right side for `extensionKind: ["workspace", "ui"]`.
- `--force` is required when the version number hasn't bumped (VS Code refuses to reinstall the same `3.0.148` otherwise).
- One-shot rebuild + reinstall:
  ```bash
  vsce package --no-git-tag-version --allow-missing-repository \
    && code --install-extension ./spellright-local-3.0.148.vsix --force
  ```
- Reload the window afterwards (`Ctrl+Shift+P → Developer: Reload Window`, or `code -r .` from the shell).
- To install on the **Windows side** instead, run `code.exe --install-extension <path>` from PowerShell or `cmd.exe`.

Useful CLI commands:

```bash
code --list-extensions --show-versions | grep spellright   # confirm install
code --uninstall-extension local.spellright-local          # remove
```

### Install via the GUI

- **Local-only use** (no remote): Extensions panel → ... → Install from VSIX
- **WSL/Remote GUI install**: connect to the remote first (title bar shows `[WSL: Ubuntu]` or similar), then ... → Install from VSIX while connected — this puts the extension on the workspace side.

Verify with `Developer: Show Running Extensions` — the entry should show kind `Workspace` when running on WSL/Remote.

The extension ID is `local.spellright-local` (publisher `local`, name `spellright-local`) to avoid conflicting with the marketplace extension `ban.spellright`.

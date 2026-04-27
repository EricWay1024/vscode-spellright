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

New file, registered in `lib/doctype.js` under language ID `typst` and extension `.typ`. Also added to the default `documentTypes` list in `package.json`.

### `_filter_global` filters (whole-document, applied before line-by-line parsing)

- **Math**: `/\$[\s\S]*?\$/g` — non-greedy, matches across newlines for display math blocks
- **`#identifier`**: `/#\w+/g` — blanks the identifier name after `#` (e.g. `pagebreak` in `#pagebreak()`)
- **`@reference`**: `/@[\w:.-]+/g` — blanks citation/label references (e.g. `@cor:my-label`)

Note: `#` and `@` are already word-boundary characters in `SPELLRIGHT_LEXEM_BUILD`, so only the identifier after them needs blanking.

### `_filter_line` filters (per line)

- **`#import` lines**: `/^\s*#import\b.*/g` — blanks the entire line, catching paths and imported names (e.g. `#import "../../lib.typ": *`)
- URLs and email addresses (same as plaintext parser)

### `_parse`

Identical structure to the plaintext parser. Tokens are tagged with `parser: 'typst'` which enables per-parser notification class configuration via `spellright.notificationClassByParser`.

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
| `spellchecker-linux-node22.22.1-x64.node` | **Node 22.22.1 (stock Node)** | **127** | **VS Code Server** (Remote-WSL, Remote-SSH) — extension host runs on `~/.vscode-server/bin/<hash>/node`, NOT Electron |

The Node-22 binary is the one the original upstream is missing. Without it, `spellright` activates on the local Windows side fine but silently fails on the WSL side (every `require()` in the loader's loop throws `NODE_MODULE_VERSION mismatch`), making `bindings.Spellchecker` undefined and aborting activation.

### Rebuilding the Node-server binary

When VS Code Server ships a new Node version (the version is whatever `~/.vscode-server/bin/<latest-hash>/node --version` reports), rebuild against the new target:

```bash
cd lib/bin/node-spellchecker
npx node-gyp rebuild --target=<NODE_VERSION> --arch=x64
cp build/Release/spellchecker.node ../spellchecker-linux-node<NODE_VERSION>-x64.node
```

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

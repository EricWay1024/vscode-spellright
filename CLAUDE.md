# Implementation Notes for This Fork

## Architecture overview

- `lib/doctype.js` — maps language IDs and file extensions to parser instances
- `lib/parser.js` — base parser class; defines global regexes `SPELLRIGHT_LEXEM_BUILD` / `SPELLRIGHT_LEXEM_SPELL` and `replaceAt` utility
- `lib/parsers/*.js` — one file per parser (plaintext, markdown, latex, code, xml, typst)
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
3. Scans `diagnostics` for one with `source === 'spelling'` whose range ends exactly at the typed position (`d.range.end.character === change.range.start.character` on the same line)
4. Calls `bindings.getCorrectionsForMisspelling(word)` with the language from `d['language']`
5. If suggestions exist, applies `suggestions[0]` via `editor.edit()` — this triggers another `doDiffSpellCheck` which clears the diagnostic since the word is now correct

The fix is a normal undoable edit. The diagnostic flashes briefly before the replacement fires.

### Setting

`spellright.autoCorrect` — boolean, default `false`, added to `package.json` `contributes.configuration.properties`.

## Building and installing

```bash
# From /home/eric/projects/vscode-spellright
vsce package --no-git-tag-version --allow-missing-repository
```

Install the resulting `spellright-local-*.vsix` via VS Code:
**Extensions panel → ... → Install from VSIX** → `\\wsl$\Ubuntu\home\eric\projects\vscode-spellright\spellright-local-3.0.148.vsix`

The extension ID is `local.spellright-local` (publisher `local`, name `spellright-local`) to avoid conflicting with the marketplace extension `ban.spellright`.

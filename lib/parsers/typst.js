// -----------------------------------------------------------------------------
// Spell Right extension for Visual Studio Code (VSCode)
// Copyright (c) 2017-2019 Bartosz Antosik. Licensed under the MIT License.
// -----------------------------------------------------------------------------

'use strict';

const vscode = require('vscode');

const Parser = require('../parser');

// Per-document cache of decoded Tinymist semantic tokens. Populated by
// src/spellright.js (refreshTypstSemanticTokens) on document open / change /
// after debounce. The parser reads from this cache synchronously; on miss
// or version mismatch it falls back to the regex filters below.
//
// Key: document.uri.toString()
// Value:
//   'pending'      — fetch in flight
//   'unavailable'  — Tinymist not installed or returned no tokens
//   { data: Uint32Array, legend: { tokenTypes: string[], tokenModifiers: string[] }, version: number }
const SEMANTIC_CACHE = new Map();

// Per-document memoization of the filtered _filter_global output. Key is
// the URI; value tracks the inputs the output depends on, so we can
// invalidate when *anything* changes (document edit, semantic refresh,
// settings flip). Big win because spellCheckRange / parseForCommands /
// every doStepSpellCheck batch each call _filter_global on the *whole*
// document — without this, a 50-line edit re-walks the doc N times.
const FILTERED_CACHE = new Map();  // uriKey → { docVersion, semVersion, optsFp, out }

// Token-type names Tinymist emits for natural-language spans. See
// crates/tinymist-query/src/analysis/semantic_tokens.rs in the tinymist repo.
// Plain markup leaves default to 'text'; headings, list terms get their own
// types. Comments/strings are gated by user setting.
const ALWAYS_SPELLABLE = ['text', 'heading', 'term'];

// Token types that override any child token's spellable mark. Tinymist emits
// a parent token for the container AND per-leaf Text tokens for inner words
// (leaf nodes default to TokenType::Text), so without this override the
// inner words leak through as spellable.
const OVERRIDE_NON_SPELLABLE = new Set(['raw', 'link', 'ref', 'label']);

function applySemanticFilter(text, entry, opts) {
    const data = entry.data;
    const tokenTypes = entry.legend.tokenTypes;
    const tokenModifiers = entry.legend.tokenModifiers;

    const spellable = new Set(ALWAYS_SPELLABLE);
    if (opts.typstSpellCheckComments) spellable.add('comment');
    if (opts.typstSpellCheckStrings)  spellable.add('string');

    const mathIdx = tokenModifiers.indexOf('math');
    const mathBit = mathIdx >= 0 ? (1 << mathIdx) : 0;

    const len = text.length;

    // Precompute UTF-16 offsets of each line start in `text`. LSP semantic
    // tokens use UTF-16 positions and VS Code documents are UTF-16, so the
    // arithmetic lines up directly.
    const lineStarts = [0];
    for (let i = 0; i < len; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1);
    }

    // Walk tokens once, decoding (line, char) deltas into absolute offsets,
    // and collect them. Default marker bit = not spellable: every Tinymist
    // leaf node is tokenized, so uncovered chars are structural whitespace
    // we don't need to check.
    const marker = new Uint8Array(len);
    const overrides = [];
    const delims = [];

    let curLine = 0;
    let curChar = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const dLine  = data[i];
        const dChar  = data[i + 1];
        const tokLen = data[i + 2];
        const typeIdx = data[i + 3];
        const modMask = data[i + 4];

        if (dLine === 0) {
            curChar += dChar;
        } else {
            curLine += dLine;
            curChar = dChar;
        }

        if (curLine >= lineStarts.length) continue;

        const typeName = tokenTypes[typeIdx];
        const start = lineStarts[curLine] + curChar;
        const end = Math.min(start + tokLen, len);

        if (typeName === 'delim') {
            delims.push([start, end]);
            overrides.push([start, end]);
            continue;
        }
        if (OVERRIDE_NON_SPELLABLE.has(typeName)) {
            overrides.push([start, end]);
            continue;
        }
        if (!spellable.has(typeName)) continue;
        if (mathBit && (modMask & mathBit)) continue;

        for (let j = start; j < end; j++) marker[j] = 1;
    }

    // Apply overrides so containers (raw, link, ...) win over any inner
    // leaf-default Text tokens that may have marked their interior spellable.
    for (let i = 0; i < overrides.length; i++) {
        const [s, e] = overrides[i];
        for (let j = s; j < e; j++) marker[j] = 0;
    }

    // Tinymist (at least the version we're targeting) does not emit `raw`
    // tokens for backtick spans — block raw content gets tokenized as plain
    // `text`, and the surrounding fences as `delim` only for math. So we
    // fall back to a text-scan for the two raw forms and clear those ranges.
    // This isn't a regex *fallback* for spell checking; it's a small
    // supplement for one specific construct Tinymist's semantic-token output
    // happens not to cover.
    const blockRaw = /```[\s\S]*?```/g;
    let m;
    while ((m = blockRaw.exec(text)) !== null) {
        const s = m.index, e = m.index + m[0].length;
        for (let j = s; j < e; j++) marker[j] = 0;
    }
    const inlineRaw = /`[^`\n]+`/g;
    while ((m = inlineRaw.exec(text)) !== null) {
        const s = m.index, e = m.index + m[0].length;
        for (let j = s; j < e; j++) marker[j] = 0;
    }

    // Build the filtered text. Non-spellable chars become spaces; \r and \n
    // are preserved verbatim so line/column geometry stays intact (required
    // by the parser walker — see CLAUDE.md).
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
        if (marker[i]) {
            out[i] = text[i];
        } else {
            const c = text.charCodeAt(i);
            out[i] = (c === 10 || c === 13) ? text[i] : ' ';
        }
    }
    return out.join('');
}

class Typst extends Parser.default {

    _filter_global(document, text, options) {

        var match;

        const uriKey = document.uri.toString();
        const semEntry = SEMANTIC_CACHE.get(uriKey);
        const semVersion = (semEntry && typeof semEntry === 'object') ? semEntry.version : null;
        const optsFp = (options.typstSpellCheckComments ? 1 : 0) |
                       (options.typstSpellCheckStrings  ? 2 : 0) |
                       ((options.ignoreRegExpsMap ? options.ignoreRegExpsMap.length : 0) << 2);

        const cached = FILTERED_CACHE.get(uriKey);
        if (cached && cached.docVersion === document.version &&
            cached.semVersion === semVersion && cached.optsFp === optsFp) {
            return cached.out;
        }

        // Matching RegExps from settings. They are "spaced out" just except
        // EOL chars so NOT to change the size/geometry of the document.
        for (var i = 0; i < options.ignoreRegExpsMap.length; i++) {
            while (match = options.ignoreRegExpsMap[i].exec(text)) {
                var replace = match[0].replace(/(?:[^\r\n]|\r(?!\n))/g, ' ');
                text = Parser.replaceAt(text, match.index, replace);
            }
        }

        var out;
        if (semEntry && semEntry !== 'pending' && semEntry !== 'unavailable' &&
            semEntry.version === document.version) {
            out = applySemanticFilter(text, semEntry, options);
        } else {
            // No fresh semantic tokens — fall back to regex so autocorrect
            // and diff spell-check still see a misspelled word *before* the
            // next semantic refresh lands (~200 ms debounce per keystroke).
            // Less accurate than the semantic path; the alternative (blank
            // everything) silently disables autocorrect mid-typing.
            var re = /\$[\s\S]*?\$/g;
            while (match = re.exec(text)) {
                var replace = match[0].replace(/(?:[^\r\n]|\r(?!\n))/g, ' ');
                text = Parser.replaceAt(text, match.index, replace);
            }
            re = /#\w+/g;
            while (match = re.exec(text)) {
                var replace = ' '.repeat(match[0].length);
                text = Parser.replaceAt(text, match.index, replace);
            }
            re = /@[\w:.-]+/g;
            while (match = re.exec(text)) {
                var replace = ' '.repeat(match[0].length);
                text = Parser.replaceAt(text, match.index, replace);
            }
            re = /```[\s\S]*?```/g;
            while (match = re.exec(text)) {
                var replace = match[0].replace(/(?:[^\r\n]|\r(?!\n))/g, ' ');
                text = Parser.replaceAt(text, match.index, replace);
            }
            re = /`[^`\n]+`/g;
            while (match = re.exec(text)) {
                var replace = ' '.repeat(match[0].length);
                text = Parser.replaceAt(text, match.index, replace);
            }
            out = text;
        }

        FILTERED_CACHE.set(uriKey, {
            docVersion: document.version,
            semVersion: semVersion,
            optsFp: optsFp,
            out: out
        });
        return out;
    }

    _filter_line(document, text, options) {

        var match;

        // #import lines: blanks the entire line including paths and imported
        // names. Useful when the regex-fallback path is active; harmless when
        // semantic tokens are in use (the line is already fully classified).
        var re = /^\s*#import\b.*/g;
        while (match = re.exec(text)) {
            var replace = ' '.repeat(match[0].length);
            text = Parser.replaceAt(text, match.index, replace);
        }

        // Defensive URL / e-mail stripping for URLs that land inside
        // semantically-spellable spans (e.g. a paragraph that mentions a
        // bare URL). Tinymist tags Typst link syntax as `link`, but plain
        // text URLs aren't recognized.
        re = /(http|ftp|https):\/\/[\w-]+(\.[\w-]+)+([\w.,@?^=%&amp;:\/~+#-]*[\w@?^=%&amp;\/~+#-])?/g;
        while (match = re.exec(text)) {
            var replace = ' '.repeat(match[0].length);
            text = Parser.replaceAt(text, match.index, replace);
        }

        re = /(mailto:)*(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/g;
        while (match = re.exec(text)) {
            var replace = ' '.repeat(match[0].length);
            text = Parser.replaceAt(text, match.index, replace);
        }

        return text;
    }

    _parse(document, diagnostics, options, checkAndMarkCallback, commandCallback, contextCallback, sline, scharacter, eline, echaracter) {

        var text = this._filter_global(document, document.getText(), options);

        var _pos = 0;
        var _linecount = 0;
        var _colcount = 0;
        var _syntax = 0;

        var InContent = true;

        var _line_text = '';
        var _line_trace = (-1);

        var token = '';
        var linenumber = 0;
        var colnumber = 0;

        var _command = SPELLRIGHT_COMMAND;
        var _command_m = _command.exec(text);

        var context = 'body';

        contextCallback(context);

        if (typeof sline === 'undefined')
            sline = 0;
        if (typeof eline === 'undefined')
            eline = Number.MAX_SAFE_INTEGER;

        // Extract areas to spellcheck
        while (_pos < text.length) {

            if (InContent) {
                if (token == '') {
                    linenumber = _linecount;
                    colnumber = _colcount;
                }

                if (checkAndMarkCallback && sline <= linenumber && linenumber <= eline) {

                    // Extract line, then filter & spell
                    if (_line_trace != _linecount) {
                        var _n_pos = text.indexOf('\n', _pos);
                        if (_n_pos == -1) _n_pos = text.length;
                        if (text[_n_pos - 1] == '\r') {
                            var _line_len = _colcount + _n_pos - _pos - 1;
                        } else {
                            var _line_len = _colcount + _n_pos - _pos;
                        }
                        _line_text = this._filter_line(document, text.substr(_pos - _colcount, _line_len), options);
                        _line_trace = _linecount;
                    }

                    // Build lexem to check
                    if (_line_text[_colcount] && SPELLRIGHT_LEXEM_BUILD.test(_line_text[_colcount])) {
                        token += _line_text[_colcount];
                    }

                    // Check spelling & tag diagnostics
                    if (token && (SPELLRIGHT_LEXEM_SPELL.test(_line_text[_colcount]) || _colcount == _line_text.length - 1)) {

                        if (typeof echaracter !== 'undefined') {
                            if (echaracter != colnumber + (token.length - 1)) {
                                checkAndMarkCallback(document, context, diagnostics, { word: token, parser: 'typst' }, linenumber, colnumber);
                            }
                        } else {
                            checkAndMarkCallback(document, context, diagnostics, { word: token, parser: 'typst' }, linenumber, colnumber);
                        }
                        token = '';
                    }
                }
            }

            // Line end - finish token. Fine for LF or CRLF.
            if (text[_pos] === '\n') {
                _linecount++;
                _colcount = 0;
            } else {
                _colcount++;
            }
            _pos++;
        }
        return { syntax: _syntax, linecount: _linecount };
    }
}
Object.defineProperty(exports, '__esModule', { value: true });
exports.default = Typst;
exports.SEMANTIC_CACHE = SEMANTIC_CACHE;
exports.FILTERED_CACHE = FILTERED_CACHE;

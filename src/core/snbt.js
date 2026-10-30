'use strict';
/**
 * Lenient SNBT / JSON parser that remembers the exact position of every
 * string literal. This lets us replace only the text values in a file
 * while keeping all other content (ids, numbers, formatting) byte-for-byte intact.
 *
 * Supports: compounds {k: v}, lists [..], typed arrays [I; 1, 2],
 * quoted ("..." / '...') and bare keys/values, commas or newlines as separators.
 * Since JSON is a subset of this grammar, the same parser is used for JSON files.
 */

class ParseError extends Error {
  constructor(msg, pos, text) {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    super(`${msg} (строка ${line})`);
    this.pos = pos;
  }
}

function parse(text) {
  let i = 0;
  const n = text.length;
  const strings = []; // { path, start, end, value, quote }

  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM

  function skip() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
      // line comments (some hand-written files contain them)
      if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      if (c === '#' && (i === 0 || text[i - 1] === '\n')) { while (i < n && text[i] !== '\n') i++; continue; }
      break;
    }
  }

  function parseString() {
    const q = text[i];
    const start = i;
    i++;
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        const d = text[i + 1];
        i += 2;
        switch (d) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'u': out += String.fromCharCode(parseInt(text.substr(i, 4), 16)); i += 4; break;
          default: out += d;
        }
        continue;
      }
      if (c === q) { i++; return { start, end: i, value: out, quote: q }; }
      out += c;
      i++;
    }
    throw new ParseError('Незакрытая строка', start, text);
  }

  function parseBare(stopAtColon) {
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === ']' || c === '}' || c === '{' || c === '[') break;
      if (stopAtColon && c === ':') break;
      i++;
    }
    if (i === start) throw new ParseError(`Неожиданный символ '${text[i] || 'EOF'}'`, i, text);
    return text.slice(start, i);
  }

  function parseValue(path) {
    skip();
    const c = text[i];
    if (c === '{') return parseCompound(path);
    if (c === '[') return parseList(path);
    if (c === '"' || c === "'") {
      const s = parseString();
      strings.push({ path, start: s.start, end: s.end, value: s.value, quote: s.quote });
      return s.value;
    }
    return { __bare: parseBare(false) };
  }

  function parseCompound(path) {
    i++; // {
    const obj = {};
    for (;;) {
      skip();
      if (i >= n) throw new ParseError('Незакрытая фигурная скобка', i, text);
      if (text[i] === '}') { i++; return obj; }
      let key;
      if (text[i] === '"' || text[i] === "'") key = parseString().value;
      else key = parseBare(true);
      skip();
      if (text[i] !== ':') throw new ParseError(`Ожидалось ':' после ключа "${key}"`, i, text);
      i++;
      obj[key] = parseValue(path.concat([key]));
    }
  }

  function parseList(path) {
    i++; // [
    skip();
    if (/^[BIL];/.test(text.substr(i, 2))) i += 2;
    const arr = [];
    for (;;) {
      skip();
      if (i >= n) throw new ParseError('Незакрытая квадратная скобка', i, text);
      if (text[i] === ']') { i++; return arr; }
      arr.push(parseValue(path.concat([arr.length])));
    }
  }

  skip();
  const root = parseValue([]);
  return { root, strings };
}

/** Encode a string literal for writing back into the file. */
function encodeString(value, quote, format) {
  if (format === 'json') return JSON.stringify(value);
  const q = quote || '"';
  let s = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  s = s.split(q).join('\\' + q);
  return q + s + q;
}

/** Apply replacements [{start, end, text}] to the source text. */
function splice(text, replacements) {
  const sorted = replacements.slice().sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of sorted) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}

function pathToId(path) {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').replace(/^\./, '');
}

module.exports = { parse, encodeString, splice, pathToId, ParseError };

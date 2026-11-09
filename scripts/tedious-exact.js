'use strict';
// tedious turns DECIMAL/NUMERIC and MONEY values into JavaScript numbers, which keep only about 15-17 digits.
// DECIMAL(20,0) 9007199254740993 came back as 9007199254740992, so the grid showed the wrong value, exports
// wrote it, and a grid edit of that row was saved into the row whose key really is 9007199254740992 (VER16).
// This build step replaces the two readers in tedious/lib/value-parser.js with exact ones: the value stays a
// number when the number is exact, and becomes the exact decimal text when a number would lose digits.
const MARK = '/* zovo-exact-numeric */';

const EXACT = `
${MARK}
function zovoExactText(mag, negative, scale) {
  let s = mag.toString();
  if (scale > 0) {
    s = s.padStart(scale + 1, '0');
    s = s.slice(0, s.length - scale) + '.' + s.slice(s.length - scale);
  }
  return (negative && mag !== 0n ? '-' : '') + s;
}
function zovoExactValue(mag, negative, scale) {
  const text = zovoExactText(mag, negative, scale);
  const n = Number(text);
  const trimmed = scale > 0 ? text.replace(/0+$/, '').replace(/\\.$/, '') : text;
  return String(n) === (trimmed === '-0' ? '0' : trimmed) ? n : text;
}
function readNumeric(buf, offset, dataLength, _precision, scale) {
  if (buf.length < offset + dataLength) throw new _helpers.NotEnoughDataError(offset + dataLength);
  if (dataLength !== 5 && dataLength !== 9 && dataLength !== 13 && dataLength !== 17) throw new Error('Unsupported numeric dataLength ' + dataLength);
  const negative = buf.readUInt8(offset) !== 1;
  let mag = 0n;
  for (let i = dataLength - 1; i >= 1; i--) mag = (mag << 8n) | BigInt(buf[offset + i]);
  return new _helpers.Result(zovoExactValue(mag, negative, scale), offset + dataLength);
}
function readMoney(buf, offset) {
  if (buf.length < offset + 8) throw new _helpers.NotEnoughDataError(offset + 8);
  const high = buf.readInt32LE(offset);
  const low = buf.readUInt32LE(offset + 4);
  const raw = (BigInt(high) << 32n) + BigInt(low);
  return new _helpers.Result(zovoExactValue(raw < 0n ? -raw : raw, raw < 0n, 4), offset + 8);
}
`;

function transform(src) {
  if (src.includes(MARK)) return src;
  const out = src.replace(/\bfunction readNumeric\(/, 'function readNumeric_tedious(').replace(/\bfunction readMoney\(/, 'function readMoney_tedious(');
  if (out === src || !/readNumeric_tedious/.test(out) || !/readMoney_tedious/.test(out) || !/_helpers\.NotEnoughDataError|NotEnoughDataError/.test(src)) {
    throw new Error('tedious-exact: value-parser.js changed shape; check the exact DECIMAL/MONEY readers before building');
  }
  return out + EXACT;
}

const plugin = {
  name: 'tedious-exact-numeric',
  setup(b) {
    const fs = require('fs');
    b.onLoad({ filter: /[\\/]tedious[\\/]lib[\\/]value-parser\.js$/ }, (a) => ({ contents: transform(fs.readFileSync(a.path, 'utf8')), loader: 'js' }));
  },
};

module.exports = { transform, plugin, MARK };

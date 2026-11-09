'use strict';
// VER16: SQL Server DECIMAL/NUMERIC/MONEY values must reach the grid, exports and grid edits exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { transform, MARK } = require('../scripts/tedious-exact');
const { editStatements } = require('../src/core/dialect');

function parser(patched) {
  const p = require.resolve('tedious/lib/value-parser.js');
  const m = new Module(p, module);
  m.filename = p;
  m.paths = Module._nodeModulePaths(path.dirname(p));
  const src = fs.readFileSync(p, 'utf8');
  m._compile(patched ? transform(src) : src, p);
  return m.exports;
}
const exact = parser(true);
const original = parser(false);

// TDS DECIMALN value: 1 length byte, 1 sign byte (1 = positive), magnitude little-endian.
function decimalBuf(text) {
  const neg = text.startsWith('-');
  const digits = text.replace('-', '').replace('.', '');
  let mag = BigInt(digits);
  const len = mag < 2n ** 32n ? 5 : mag < 2n ** 64n ? 9 : mag < 2n ** 96n ? 13 : 17;
  const b = Buffer.alloc(1 + len);
  b[0] = len;
  b[1] = neg ? 0 : 1;
  for (let i = 2; i < 1 + len; i++) { b[i] = Number(mag & 0xffn); mag >>= 8n; }
  return b;
}
const dec = (prec, scale) => ({ type: { name: 'DecimalN' }, precision: prec, scale });
const read = (P, buf, meta) => P.readValue(buf, 0, meta, {}).value;

test('the build patch is applied to tedious value-parser.js exactly once', () => {
  const src = fs.readFileSync(require.resolve('tedious/lib/value-parser.js'), 'utf8');
  const once = transform(src);
  assert.ok(once.includes(MARK));
  assert.equal(transform(once), once);
  assert.throws(() => transform('function other() {}'), /changed shape/);
});

test('DECIMAL(20,0) keys above 2^53 stay exact (the unpatched tedious merges them)', () => {
  assert.equal(read(original, decimalBuf('9007199254740993'), dec(20, 0)), 9007199254740992, 'tedious itself rounds');
  assert.equal(read(exact, decimalBuf('9007199254740993'), dec(20, 0)), '9007199254740993');
  assert.equal(read(exact, decimalBuf('9007199254740992'), dec(20, 0)), 9007199254740992);
  assert.equal(read(exact, decimalBuf('-12345678901234567890123456789012345678'), dec(38, 0)), '-12345678901234567890123456789012345678');
});

test('ordinary decimals stay JavaScript numbers; long fractions keep every digit', () => {
  assert.equal(read(exact, decimalBuf('12.50'), dec(10, 2)), 12.5);
  assert.equal(read(exact, decimalBuf('-0.01'), dec(10, 2)), -0.01);
  assert.equal(read(exact, decimalBuf('0.00'), dec(10, 2)), 0);
  assert.equal(read(exact, decimalBuf('100'), dec(10, 0)), 100);
  assert.equal(read(exact, decimalBuf('12345678901234.5678'), dec(18, 4)), '12345678901234.5678');
  assert.equal(read(exact, decimalBuf('0.0000001'), dec(10, 7)), '0.0000001');
  assert.equal(read(exact, Buffer.from([0]), dec(10, 2)), null);
});

test('MONEY keeps 4 decimals exactly, including the type limits', () => {
  const money = (big) => { const b = Buffer.alloc(8); b.writeInt32LE(Number(BigInt.asIntN(32, big >> 32n)), 0); b.writeUInt32LE(Number(big & 0xffffffffn), 4); return b; };
  const M = { type: { name: 'Money' } };
  assert.equal(read(original, money(9223372036854775807n), M), 922337203685477.6, 'tedious itself rounds');
  assert.equal(read(exact, money(9223372036854775807n), M), '922337203685477.5807');
  assert.equal(read(exact, money(-9223372036854775808n), M), '-922337203685477.5808');
  assert.equal(read(exact, money(12345n), M), 1.2345);
  assert.equal(read(exact, money(-1n), M), -0.0001);
});

test('a short buffer still asks tedious for more data', () => {
  assert.throws(() => exact.readValue(decimalBuf('9007199254740993').subarray(0, 5), 0, dec(20, 0), {}), (e) => e.constructor.name === 'NotEnoughDataError');
});

test('a grid edit keyed by an exact decimal text targets that row only', () => {
  const [st] = editStatements({ schema: 'dbo', table: 'prec', pk: ['id'] }, [{ kind: 'update', key: { id: '9007199254740993' }, set: { v: 'X' } }], 'mssql');
  assert.equal(st.sql, "UPDATE [dbo].[prec] SET [v] = N'X' WHERE [id] = N'9007199254740993'");
});

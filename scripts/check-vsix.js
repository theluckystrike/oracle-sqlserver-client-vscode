'use strict';
// Fails when the vsix holds a native module or is 8 MB or larger.
const { execFileSync } = require('child_process');
const fs = require('fs');
const file = process.argv[2];
const list = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
const native = list.split('\n').filter((l) => /\.node\s*$/.test(l));
const size = fs.statSync(file).size;
console.log(`${file}: ${(size / 1048576).toFixed(2)} MB, ${list.trim().split('\n').slice(-1)[0].trim()}, native modules: ${native.length}`);
if (native.length || size >= 8 * 1048576) process.exit(1);

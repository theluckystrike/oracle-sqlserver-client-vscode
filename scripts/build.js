'use strict';
// Bundles the extension host and the webview with esbuild.
// tedious and node-oracledb (Thin mode) are pure JavaScript. node-oracledb's Thick-mode binaries are never bundled:
// the extension never calls initOracleClient(), and scripts/check-vsix.js fails the build if a .node file ships.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { plugin: tediousExact } = require('./tedious-exact');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: !prod, legalComments: 'none', logLevel: 'warning', absWorkingDir: root };
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
// Thick mode loads its binary with a computed require(); point it at a stub so nothing native is ever resolved.
const noNative = {
  name: 'no-native',
  setup(b) {
    b.onResolve({ filter: /\.node$/ }, (a) => ({ path: a.path, namespace: 'no-native' }));
    b.onLoad({ filter: /.*/, namespace: 'no-native' }, () => ({ contents: 'throw new Error("Thick mode is not part of this extension.");', loader: 'js' }));
  },
};
Promise.all([
  esbuild.build({
    ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18',
    external: ['vscode'], plugins: [noNative, tediousExact], metafile: true,
  }).then((r) => { if (process.argv.includes('--meta')) fs.writeFileSync(path.join(root, 'dist', 'meta.json'), JSON.stringify(r.metafile)); }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
]).catch((e) => { console.error(e); process.exit(1); });

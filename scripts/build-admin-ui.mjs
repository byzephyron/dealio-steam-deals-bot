// Builds the admin panel into dist/admin-ui: one minified app.js bundle (Preact/htm
// included), a minified boot.js and styles.css, the images and the self-hosted fonts.
// The panel is reached through an SSH tunnel, where every request costs a round trip,
// so index.html and styles.css name each file with `?v=<content hash>`; the admin
// server caches those URLs for good and revalidates everything else.
// Runs after `tsc -p tsconfig.admin-ui.json --noEmit` in `npm run build`.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'admin-ui');
const target = join(root, 'dist', 'admin-ui');
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'fonts'), { recursive: true });

/** Same hash as `assetVersion` in src/admin/admin-server.ts. */
const version = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const versioned = (path) => `${path}?v=${version(readFileSync(join(target, path)))}`;

// The sources import the vendored `htm/preact/standalone` build as ./vendor/preact-htm.js.
const vendor = {
  name: 'preact-htm',
  setup(builder) {
    builder.onResolve({ filter: /\/vendor\/preact-htm\.js$/ }, () => ({
      path: join(root, 'node_modules', 'htm', 'preact', 'standalone.module.js'),
    }));
  },
};
const common = { bundle: true, minify: true, target: 'es2022', legalComments: 'eof', logLevel: 'warning' };
await build({ ...common, entryPoints: [join(source, 'src', 'app.ts')], format: 'esm', outfile: join(target, 'app.js'), plugins: [vendor] });
await build({ ...common, entryPoints: [join(source, 'src', 'boot.ts')], format: 'iife', outfile: join(target, 'boot.js') });

for (const file of readdirSync(source)) {
  if (/\.(svg|png)$/.test(file)) copyFileSync(join(source, file), join(target, file));
}
// Latin and Latin Extended cover Turkish, German and French (SIL Open Font License).
// Archivo's "standard" files carry both the weight and the width axis.
for (const subset of ['latin', 'latin-ext']) {
  for (const [family, file] of [['inter', `inter-${subset}-wght-normal.woff2`], ['archivo', `archivo-${subset}-standard-normal.woff2`]]) {
    copyFileSync(join(root, 'node_modules', '@fontsource-variable', family, 'files', file), join(target, 'fonts', file));
  }
}

const css = (await transform(readFileSync(join(source, 'styles.css'), 'utf8'), { loader: 'css', minify: true })).code
  .replace(/url\(\/(fonts\/[\w.-]+\.woff2)\)/g, (_match, path) => `url(/${versioned(path)})`);
writeFileSync(join(target, 'styles.css'), css);

const page = readFileSync(join(source, 'index.html'), 'utf8')
  .replace(/(href|src)="\/([\w./-]+\.(?:js|css|png|woff2))"/g, (_match, attribute, path) => `${attribute}="/${versioned(path)}"`);
writeFileSync(join(target, 'index.html'), page);

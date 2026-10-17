// Copies the admin panel's static files, the vendored Preact/htm build and the
// self-hosted Inter font into dist/admin-ui. Runs after
// `tsc -p tsconfig.admin-ui.json` in `npm run build`.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'dist', 'admin-ui');
mkdirSync(join(target, 'vendor'), { recursive: true });
mkdirSync(join(target, 'fonts'), { recursive: true });
for (const file of readdirSync(join(root, 'admin-ui'))) {
  if (/\.(html|css|svg|png)$/.test(file)) copyFileSync(join(root, 'admin-ui', file), join(target, file));
}
copyFileSync(join(root, 'node_modules', 'htm', 'preact', 'standalone.module.js'), join(target, 'vendor', 'preact-htm.js'));
// Latin and Latin Extended cover Turkish, German and French (SIL Open Font License).
// Archivo's "standard" files carry both the weight and the width axis.
for (const subset of ['latin', 'latin-ext']) {
  for (const [family, file] of [['inter', `inter-${subset}-wght-normal.woff2`], ['archivo', `archivo-${subset}-standard-normal.woff2`]]) {
    copyFileSync(join(root, 'node_modules', '@fontsource-variable', family, 'files', file), join(target, 'fonts', file));
  }
}

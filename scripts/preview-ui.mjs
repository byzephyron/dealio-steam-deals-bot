// Local design review from the production component builders. All values are demo fixtures.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildPreviewPanels } from './ui-fixtures.mjs';
const data = JSON.stringify(buildPreviewPanels()).replaceAll('<', '\\u003c');
const html = await readFile(new URL('./ui-preview-shell.html', import.meta.url), 'utf8');
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/ui-preview.html', html.replace('DATA_PLACEHOLDER', data));
console.log('Design preview: .runtime/ui-preview.html');

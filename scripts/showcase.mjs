// Website showcase: every preview panel drawn as a Discord message, and optionally saved as
// 3x PNGs with a transparent background. All values are demo fixtures from ui-fixtures.mjs.
// Usage: node scripts/showcase.mjs [--png] [--lang tr,en] [--scale 3]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPreviewPanels } from './ui-fixtures.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const out = resolve('.runtime/showcase');
const panels = buildPreviewPanels();
const languages = option('--lang', Object.keys(panels).join(',')).split(',');
const scale = Number(option('--scale', '3'));

await mkdir(join(out, 'assets'), { recursive: true });
const fonts = 'node_modules/@fontsource-variable/inter/files/';
await copyFile(fonts + 'inter-latin-wght-normal.woff2', join(out, 'assets/inter-latin.woff2'));
await copyFile(fonts + 'inter-latin-ext-wght-normal.woff2', join(out, 'assets/inter-latin-ext.woff2'));
await copyFile('admin-ui/logo.png', join(out, 'assets/dealio.png'));
const shell = await readFile(new URL('./showcase-shell.html', import.meta.url), 'utf8');
const page = join(out, 'index.html');
await writeFile(page, shell.replace('DATA_PLACEHOLDER', JSON.stringify(panels).replaceAll('<', '\\u003c')));
console.log('Showcase: ' + page);

if (args.includes('--png')) await capture();

function findBrowser() {
  const candidates = [
    process.env.DEALIO_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) throw new Error('No Chrome or Edge found; set DEALIO_BROWSER to its executable.');
  return found;
}

async function capture() {
  const profile = await mkdtemp(join(tmpdir(), 'dealio-showcase-'));
  const browser = spawn(findBrowser(), ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise((ok) => browser.once('exit', ok));
  let cdp;
  try {
    const port = await debuggingPort(profile);
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = await connect(webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    let count = 0;
    for (const language of languages) {
      for (const width of ['desktop', 'mobile']) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: scale, mobile: false });
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: pathToFileURL(page).href + `?capture&lang=${language}&width=${width}` });
        await loaded;
        const { result } = await cdp.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression:
          `showcaseReady.then(() => [...document.querySelectorAll('.shot')].map((el) => {
             const r = el.getBoundingClientRect();
             return { key: el.dataset.key, x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
           }))` });
        const dir = join(out, 'png', language, width);
        await mkdir(dir, { recursive: true });
        for (const shot of result.value) {
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
            clip: { x: shot.x, y: shot.y, width: shot.width, height: shot.height, scale: 1 } });
          await writeFile(join(dir, shot.key + '.png'), Buffer.from(data, 'base64'));
          count += 1;
        }
      }
    }
    console.log(`Saved ${count} PNGs at ${scale}x: ${join(out, 'png')}`);
  } finally {
    // A killed Edge leaves helper processes holding the profile; ask it to quit instead.
    if (cdp) cdp.sessionId = undefined;
    await cdp?.send('Browser.close').catch(() => {});
    cdp?.close();
    const timer = setTimeout(() => browser.kill(), 5000);
    await exited;
    clearTimeout(timer);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  }
}

async function debuggingPort(profile) {
  const file = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(file)) {
      const port = (await readFile(file, 'utf8')).split('\n')[0];
      if (port) return port;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The browser did not open a debugging port within 10 seconds.');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { ok, fail } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) fail(new Error(message.error.message)); else ok(message.result);
    } else if (message.method) {
      listeners.get(message.method)?.splice(0).forEach((fn) => fn(message.params));
    }
  };
  return {
    sessionId: undefined,
    send(method, params = {}) {
      return new Promise((ok, fail) => {
        id += 1;
        pending.set(id, { ok, fail });
        socket.send(JSON.stringify({ id, method, params, ...(this.sessionId ? { sessionId: this.sessionId } : {}) }));
      });
    },
    once: (method) => new Promise((ok) => listeners.set(method, [...(listeners.get(method) ?? []), ok])),
    close: () => socket.close(),
  };
}

// Loaded as a classic script in <head> before the stylesheet applies, so the saved
// theme is set before the first paint (no flash). The CSP forbids inline scripts.
// It also starts the first requests while app.js is still loading: through the SSH
// tunnel each round trip counts, and the session check and the opening page's data
// would otherwise wait for the bundle and then for each other.
(() => {
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem('dealio-admin-theme');
  } catch {
    // Storage can be blocked; fall back to the system setting.
  }
  const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved : system;

  // `#login=<code>` signs in first (app.ts), so there is nothing to ask yet.
  if (window.location.hash.startsWith('#login=')) return;
  const get = (path: string): Promise<unknown> => fetch(path, {
    credentials: 'same-origin', headers: { Accept: 'application/json' },
  }).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))));
  const boot = window as { dealioBoot?: { session: Promise<unknown>; page?: { path: string; data: Promise<unknown> } } };
  // The API behind each page's first view (app.ts Route); other pages load as usual.
  const route = window.location.hash.replace(/^#/, '').split('?')[0] || '/';
  const pages: Readonly<Record<string, string>> = {
    '/': '/api/overview', '/users': '/api/users', '/guilds': '/api/guilds', '/games': '/api/games',
    '/announcements': '/api/broadcasts', '/system': '/api/system', '/audit': '/api/audit',
  };
  const path = pages[route] ?? (/^\/(users|guilds)\/\d{5,25}$/.test(route) ? `/api${route}` : undefined);
  const session = get('/api/session');
  boot.dealioBoot = { session, ...(path ? { page: { path, data: get(path) } } : {}) };
  // Unused answers (signed out, another page) must not surface as unhandled rejections.
  session.catch(() => undefined);
  boot.dealioBoot.page?.data.catch(() => undefined);
})();

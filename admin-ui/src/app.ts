import { html, render, useEffect, useState, type VNode } from './vendor/preact-htm.js';
import { api, ApiError, bootSession, forgetResponses, setCsrfToken, whenSignedOut } from './api.js';
import { Icon, type IconName } from './icons.js';
import { GamesPage } from './pages/games.js';
import { GuildsPage } from './pages/guilds.js';
import { LogsPage } from './pages/logs.js';
import { OverviewPage } from './pages/overview.js';
import { SystemPage } from './pages/system.js';
import { UserDetailPage } from './pages/user-detail.js';
import { UsersPage } from './pages/users.js';
import { usePath } from './router.js';
import { Toasts } from './actions.js';
import { AnnouncementDetailPage, AnnouncementsPage } from './pages/announcements.js';
import { AuditPage } from './pages/audit.js';
import { GuildDetailPage } from './pages/guilds.js';
import { UsagePage } from './pages/usage.js';
import { useTheme } from './theme.js';
import { SearchPalette } from './search.js';

interface SessionResponse {
  readonly authenticated: boolean;
  readonly csrf?: string;
}

interface NavItem { readonly path: string; readonly label: string; readonly icon: IconName }

const navigation: ReadonlyArray<{ readonly label: string; readonly items: readonly NavItem[] }> = [
  { label: 'Genel', items: [
    { path: '/', label: 'Genel bakış', icon: 'dashboard' },
    { path: '/usage', label: 'Kullanım', icon: 'activity' },
  ] },
  { label: 'Topluluk', items: [
    { path: '/users', label: 'Kullanıcılar', icon: 'users' },
    { path: '/guilds', label: 'Sunucular', icon: 'server' },
    { path: '/games', label: 'Oyunlar', icon: 'gamepad' },
    { path: '/announcements', label: 'Duyurular', icon: 'megaphone' },
  ] },
  { label: 'Sistem', items: [
    { path: '/system', label: 'Sistem', icon: 'sliders' },
    { path: '/audit', label: 'Denetim', icon: 'shield' },
    { path: '/logs', label: 'Loglar', icon: 'terminal' },
  ] },
];
const sections = navigation.flatMap((group) => group.items);

function ThemeToggle(): VNode {
  const [theme, toggle] = useTheme();
  const label = theme === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç';
  return html`<button class="btn btn-icon btn-ghost" onClick=${toggle} title=${label} aria-label=${label}>
    ${Icon({ name: theme === 'dark' ? 'sun' : 'moon', size: 18 })}</button>`;
}

function Login(props: { onSignedIn: (csrf: string) => void }): VNode {
  // `null` until the server says whether the owner has set a username and password.
  const [mode, setMode] = useState<'password' | 'token' | null>(null);
  const [passwordAvailable, setPasswordAvailable] = useState(false);
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ password: boolean }>('/api/login-options')
      .then((options) => {
        setPasswordAvailable(options.password);
        setMode(options.password ? 'password' : 'token');
      })
      .catch(() => setMode('token'));
  }, []);
  const switchMode = (next: 'password' | 'token'): void => {
    setMode(next);
    setSecret('');
    setError(null);
  };
  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.post<SessionResponse>('/api/login',
        mode === 'password' ? { username: username.trim(), password: secret } : { token: secret });
      props.onSignedIn(session.csrf ?? '');
    } catch (reason: unknown) {
      setError(reason instanceof ApiError && reason.status === 429
        ? 'Çok fazla hatalı deneme. 15 dakika sonra tekrar dene.'
        : reason instanceof ApiError && reason.status === 401
          ? (mode === 'password' ? 'Kullanıcı adı veya şifre hatalı.' : 'Anahtar hatalı.')
          : 'Giriş yapılamadı.');
    } finally {
      setBusy(false);
    }
  };
  const ready = mode === 'password' ? username.trim().length > 0 && secret.length > 0 : secret.length > 0;
  return html`
    <main class="login">
      <span class="login-theme"><${ThemeToggle} /></span>
      <form class="card login-card" onSubmit=${submit}>
        <div class="login-head">
          <img class="mark mark-lg" src="/logo.png" alt="Dealio" width="64" height="64" />
          <div>
            <h1>Dealio Yönetim</h1>
            <p class="muted">${mode === 'password'
              ? 'Kullanıcı adın ve şifrenle giriş yap.'
              : html`Sunucudaki <code>DEALIO_ADMIN_TOKEN</code> değeriyle giriş yap.`}</p>
          </div>
        </div>
        ${mode === 'password' ? html`
          <label class="field">Kullanıcı adı
            <input class="input" autocomplete="username" required value=${username}
              onInput=${(event: Event) => setUsername((event.target as HTMLInputElement).value)} />
          </label>
          <label class="field">Şifre
            <input class="input" type="password" autocomplete="current-password" required value=${secret} placeholder="••••••••••••"
              onInput=${(event: Event) => setSecret((event.target as HTMLInputElement).value)} />
          </label>` : html`
          <label class="field">Yönetici anahtarı
            <input class="input" type="password" autocomplete="current-password" required value=${secret} placeholder="••••••••••••"
              onInput=${(event: Event) => setSecret((event.target as HTMLInputElement).value)} />
          </label>`}
        ${error ? html`<p class="form-error" role="alert">${Icon({ name: 'alert' })}${error}</p>` : null}
        <button class="btn btn-primary" type="submit" disabled=${busy || mode === null || !ready}>
          ${Icon({ name: 'key' })}${busy ? 'Giriş yapılıyor…' : 'Giriş yap'}</button>
        ${mode === null || !passwordAvailable ? null : html`<button class="btn btn-ghost" type="button"
          onClick=${() => switchMode(mode === 'password' ? 'token' : 'password')}>
          ${mode === 'password' ? 'Yönetici anahtarıyla giriş yap' : 'Kullanıcı adı ve şifreyle giriş yap'}</button>`}
        <p class="login-foot">${Icon({ name: 'shield', size: 14 })}Oturum 12 saat sürer; bot yeniden başlarsa kapanır.</p>
      </form>
    </main>`;
}

function Route(props: { path: string; search: string }): VNode {
  const userMatch = /^\/users\/(\d{5,25})$/.exec(props.path);
  if (userMatch) return html`<${UserDetailPage} id=${userMatch[1]} />`;
  const guildMatch = /^\/guilds\/(\d{5,25})$/.exec(props.path);
  if (guildMatch) return html`<${GuildDetailPage} id=${guildMatch[1]} />`;
  const announcementMatch = /^\/announcements\/([0-9a-f-]{36})$/.exec(props.path);
  if (announcementMatch) return html`<${AnnouncementDetailPage} id=${announcementMatch[1]} />`;
  switch (props.path) {
    case '/guilds': return html`<${GuildsPage} />`;
    case '/users': return html`<${UsersPage} search=${props.search} />`;
    case '/games': return html`<${GamesPage} />`;
    case '/usage': return html`<${UsagePage} />`;
    case '/announcements': return html`<${AnnouncementsPage} />`;
    case '/audit': return html`<${AuditPage} />`;
    case '/system': return html`<${SystemPage} />`;
    case '/logs': return html`<${LogsPage} />`;
    default: return html`<${OverviewPage} />`;
  }
}

const detailNames: Readonly<Record<string, string>> = {
  '/users': 'Kullanıcı', '/guilds': 'Sunucu', '/announcements': 'Duyuru',
};

/** "Dealio › Kullanıcılar › Kullanıcı": where the owner is, with links back up. */
function Crumbs(props: { path: string; section: string }): VNode {
  const item = sections.find((candidate) => candidate.path === props.section) ?? sections[0]!;
  const detail = props.path !== props.section && props.section !== '/' ? detailNames[props.section] : undefined;
  return html`<nav class="crumbs" aria-label="Konum">
    <a href="#/">Dealio</a>${Icon({ name: 'chevronRight', size: 14 })}
    ${detail ? html`<a href=${`#${item.path}`}>${item.label}</a>${Icon({ name: 'chevronRight', size: 14 })}<strong>${detail}</strong>`
      : html`<strong>${item.label}</strong>`}
  </nav>`;
}

function Shell(props: { onSignOut: () => void }): VNode {
  // `#/users?check=problem`: the query only preselects filters on the page.
  const [path = '/', search = ''] = usePath().split('?');
  const section = '/' + (path.split('/')[1] ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [path]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  return html`
    <div class="shell">
      <aside class=${`sidebar ${menuOpen ? 'open' : ''}`} id="sidebar">
        <div class="sidebar-top">
          <a class="brand" href="#/"><img class="mark" src="/logo.png" alt="" width="34" height="34" />
            <span class="brand-text"><strong>Dealio</strong><small>Yönetim paneli</small></span></a>
          <button class="btn btn-icon btn-ghost menu-toggle" aria-label="Menüyü kapat" onClick=${() => setMenuOpen(false)}>
            ${Icon({ name: 'x', size: 18 })}</button>
        </div>
        <div class="sidebar-scroll">
          ${navigation.map((group) => html`
            <nav class="nav-group" aria-label=${group.label}>
              <span class="nav-label">${group.label}</span>
              ${group.items.map((item) => html`<a href=${`#${item.path}`} class=${`nav-link ${section === item.path ? 'active' : ''}`}
                aria-current=${section === item.path ? 'page' : undefined}>${Icon({ name: item.icon, size: 18 })}${item.label}</a>`)}
            </nav>`)}
        </div>
        <div class="sidebar-foot">
          <div class="owner">
            <span class="owner-avatar">${Icon({ name: 'key', size: 16 })}</span>
            <span class="owner-text"><strong>Sahip</strong><small>Yerel oturum · 127.0.0.1</small></span>
            <button class="btn btn-icon btn-ghost btn-small" onClick=${props.onSignOut} title="Çıkış yap" aria-label="Çıkış yap">
              ${Icon({ name: 'logout' })}</button>
          </div>
        </div>
      </aside>
      ${menuOpen ? html`<div class="scrim" onClick=${() => setMenuOpen(false)}></div>` : null}
      <div class="main">
        <header class="topbar">
          <button class="btn btn-icon menu-toggle" aria-label="Menü" aria-expanded=${menuOpen} aria-controls="sidebar"
            onClick=${() => setMenuOpen(true)}>${Icon({ name: 'menu', size: 18 })}</button>
          <${Crumbs} path=${path} section=${section} />
          <button class="search-trigger" onClick=${() => setSearchOpen(true)} aria-label="Ara (Ctrl+K)">
            ${Icon({ name: 'search' })}<span>Kullanıcı, sunucu veya ID ara…</span><kbd>Ctrl K</kbd></button>
          <div class="topbar-actions">
            <${ThemeToggle} />
          </div>
        </header>
        <main class="content"><${Route} key=${`${path}?${search}`} path=${path} search=${search} /></main>
      </div>
      ${searchOpen ? html`<${SearchPalette} pages=${sections} onClose=${() => setSearchOpen(false)} />` : null}
      <${Toasts} />
    </div>`;
}

function App(): VNode {
  const [state, setState] = useState<'checking' | 'signed-in' | 'signed-out'>('checking');
  useEffect(() => {
    whenSignedOut(() => {
      forgetResponses();
      setCsrfToken(null);
      setState('signed-out');
    });
    // scripts/admin-tunnel.ps1 opens `#login=<code>` with a one-minute, single-use
    // code it got for the token, never the token itself; the fragment is removed
    // from the address bar before signing in.
    const login = /^#login=([^&]+)$/.exec(window.location.hash);
    if (login) window.history.replaceState(null, '', '#/');
    const early = bootSession<SessionResponse>();
    const session = login
      ? api.post<SessionResponse>('/api/login', { code: decodeURIComponent(login[1]!) })
        .catch(() => api.get<SessionResponse>('/api/session'))
      : early?.catch(() => api.get<SessionResponse>('/api/session')) ?? api.get<SessionResponse>('/api/session');
    session.then((result) => {
      setCsrfToken(result.csrf ?? null);
      setState(result.authenticated ? 'signed-in' : 'signed-out');
    }, () => setState('signed-out'));
  }, []);
  const signOut = (): void => {
    void api.post('/api/logout').finally(() => {
      forgetResponses();
      setCsrfToken(null);
      setState('signed-out');
    });
  };
  if (state === 'checking') return html`<p class="boot">Yükleniyor…</p>`;
  if (state === 'signed-out') {
    return html`<${Login} onSignedIn=${(csrf: string) => {
      setCsrfToken(csrf);
      setState('signed-in');
    }} />`;
  }
  return html`<${Shell} onSignOut=${signOut} />`;
}

const root = document.getElementById('app');
if (root) {
  root.textContent = '';
  render(html`<${App} />`, root);
}

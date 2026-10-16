import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const pages = ['index.html', 'index-en.html', 'help.html', 'help-tr.html', 'privacy.html', 'privacy-tr.html',
  'terms.html', 'terms-tr.html', 'open.html'];
const read = (path: string): string => readFileSync(resolve(path), 'utf8');

describe('public site hygiene', () => {
  it('gives every published page a restrictive Content-Security-Policy', () => {
    for (const page of pages) {
      const text = read(`docs/${page}`);
      const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(text)?.[1];
      expect(policy, page).toBeDefined();
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("base-uri 'none'");
      if (page !== 'open.html') expect(policy).not.toContain('script-src');
    }
  });

  it('keeps the hosting header policy for open.html in step with its inline script', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(read('docs/open.html'))![1]!;
    const hash = createHash('sha256').update(script).digest('base64');
    const config = JSON.parse(read('docs/staticwebapp.config.json')) as {
      routes: Array<{ route: string; headers?: Record<string, string> }>;
    };
    const route = config.routes.find((entry) => entry.route === '/open.html');
    expect(route?.headers?.['Content-Security-Policy']).toContain(`script-src 'sha256-${hash}'`);
  });

  it('publishes no addresses, secrets or private contacts', () => {
    for (const path of [...pages.map((page) => `docs/${page}`), 'README.md', 'README.tr.md', 'docs/admin-panel.tr.md']) {
      const text = read(path);
      const addresses = [...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map((match) => match[0])
        .filter((address) => address !== '127.0.0.1' && address !== '0.0.0.0');
      expect(addresses, path).toEqual([]);
      expect(text, path).not.toMatch(/hc-ping\.com\/[0-9a-f-]{8,}|ghp_[A-Za-z0-9]{20,}|cloudapp\.azure\.com/);
      const emails = [...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0]);
      expect(emails.filter((email) => email !== 'blghnboz17@gmail.com'), path).toEqual([]);
    }
  });

  it('opens no external page in a new tab without noopener', () => {
    for (const page of pages) {
      for (const match of read(`docs/${page}`).matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
        expect(match[0], page).toMatch(/rel="[^"]*noopener/);
      }
    }
  });

  it('keeps the Turkish and English privacy policies in the same shape and date', () => {
    const sections = (text: string): number => (text.match(/<h2>/g) ?? []).length;
    expect(sections(read('docs/privacy-tr.html'))).toBe(sections(read('docs/privacy.html')));
    expect(read('docs/privacy-tr.html')).toContain('Son güncelleme: 16 Ekim 2026');
    expect(read('docs/privacy.html')).toContain('Last updated: October 16, 2026');
  });

  it('describes the source repository as public, as it has been since v1.0.0', () => {
    expect(read('docs/privacy.html')).not.toContain('repository remains private');
    expect(read('docs/privacy-tr.html')).not.toContain('repo özel kalır');
    expect(read('docs/development.md')).not.toContain('repository is private');
  });

  it('links the renamed GitHub account, whose old Pages URLs return 404', () => {
    for (const file of ['README.md', 'README.tr.md', 'package.json', 'src/discord/ui/design.ts',
      'src/discord/support/support-view.ts', 'scripts/support-server/blueprint.ts',
      '.github/workflows/public-site.yml', '.github/workflows/offsite-backup.yml',
      '.github/workflows/restore-rehearsal.yml']) {
      expect(read(file), file).not.toContain('blghnboz17-boop');
    }
  });

  it('names the services Dealio is not affiliated with', () => {
    for (const page of ['terms.html', 'terms-tr.html']) {
      const text = read(`docs/${page}`);
      for (const name of ['Valve', 'Steam', 'Discord', 'IsThereAnyDeal']) expect(text, page).toContain(name);
    }
  });
});

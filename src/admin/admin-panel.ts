import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeLogger } from '../application/safe-logger.js';
import type { AdminPanelConfig } from '../config/environment.js';
import { AdminSessions } from './admin-auth.js';
import type { OwnerCredentialStore } from './owner-credentials.js';
import { AdminServer, existingDirectory, type AdminRoute, type AdminServerOptions } from './admin-server.js';
import type { LogBuffer } from './log-buffer.js';

export function adminUiDirectory(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/admin/ → dist/admin-ui; under tsx (src/admin/) the last build is used.
  return existingDirectory(resolve(here, '../admin-ui'), join(process.cwd(), 'dist', 'admin-ui'));
}

/**
 * The owner's admin panel inside the bot process. A panel that cannot start is
 * logged and skipped: it must never stop the bot itself.
 */
export class AdminPanel {
  private server: AdminServer | null = null;

  public constructor(
    private readonly config: AdminPanelConfig,
    private readonly routes: () => readonly AdminRoute[],
    private readonly logs: LogBuffer,
    private readonly logger: Pick<Console, 'log' | 'error'> = safeLogger,
    private readonly credentials: OwnerCredentialStore | null = null,
    private readonly audit?: AdminServerOptions['audit'],
  ) {}

  public async start(): Promise<void> {
    if (this.server) return;
    const staticDirectory = adminUiDirectory();
    const server = new AdminServer({
      port: this.config.port,
      sessions: new AdminSessions(this.config.token, Date.now, this.credentials),
      routes: this.routes(),
      staticDirectory,
      logger: this.logger,
      ...(this.audit ? { audit: this.audit } : {}),
    });
    try {
      const port = await server.start();
      this.server = server;
      this.logger.log(`${new Date().toISOString()} [admin] Admin panel listening on 127.0.0.1:${port}`
        + (staticDirectory ? '.' : ' (UI not built; API only).'));
    } catch (error: unknown) {
      this.logger.error(`${new Date().toISOString()} [admin] Admin panel could not start; the bot continues without it.`, error);
    }
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.stop();
    this.logs.uninstall();
  }
}

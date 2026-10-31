
import { inspect } from 'node:util';

// Exact values are redacted too: a raw token in an error message has no `token=` prefix.
const secretEnvironmentNames = ['DISCORD_TOKEN', 'DEALIO_ADMIN_TOKEN', 'ITAD_API_KEY', 'STEAM_WEB_API_KEY', 'TOPGG_TOKEN'] as const;

function redactSecretValues(text: string): string {
  let result = text;
  for (const name of secretEnvironmentNames) {
    const secret = process.env[name]?.trim();
    // Short values would redact ordinary words; real tokens and keys are far longer.
    if (secret !== undefined && secret.length >= 16) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function redactSecrets(value: unknown): string {
  const text = typeof value === 'string' ? value : inspect(value, {depth:5, maxArrayLength:20, getters:false});
  return redactSecretValues(text)
    .replace(/(https?:\/\/[^\s'"]*\/(?:webhooks|interactions)\/[^\/\s]+\/)[^\s\/?'"]+/gi, '$1[REDACTED]')
    .replace(/((?:authorization|token|password|secret|api[_-]?key)\s*['"]?\s*[:=]\s*['"]?)(?:Bot\s+|Bearer\s+|Basic\s+)?[^\s,'"}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:Bot|Bearer|Basic)\s+[\w.\-]+/g, '[REDACTED AUTH]')
    .replace(/([?&](?:sig|code|token|key)=)[^&#\s]+/gi, '$1[REDACTED]');
}

export const safeLogger = {
  error: (...values: unknown[]): void => console.error(...values.map(redactSecrets)),
  warn: (...values: unknown[]): void => console.warn(...values.map(redactSecrets)),
  log: (...values: unknown[]): void => console.log(...values.map(redactSecrets)),
};

import type { StoreCountryCode } from './store-country.js';

/** Every language Dealio speaks, in the order a picker lists them. */
export const languages = ['tr', 'en', 'de', 'fr'] as const;
export type Language = typeof languages[number];

/** The BCP 47 locale behind a language: dates, numbers, prices and country names. */
export const languageLocale: Readonly<Record<Language, string>> = {
  tr: 'tr-TR',
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
};

export interface UserConfig {
  readonly discordUserId: string;
  readonly configurationId: string;
  readonly steamId64: string;
  readonly configVersion: number;
  readonly language: Language;
  readonly storeCountryCode: StoreCountryCode;
  readonly enabled: boolean;
  readonly minimumDiscountPercent: number;
  readonly dmOptInAt: string;
  readonly dmDeliveryBlockedAt: string | null;
  readonly dmDeliveryErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Why Discord refuses Dealio's DMs, stored in dmDeliveryErrorCode. Each has its own
 * remedy: a privacy setting (50007), or no shared server or app install (50278).
 */
export type DmUnreachableCode = 'DISCORD_DM_BLOCKED' | 'DISCORD_NO_MUTUAL_GUILD';

/** A stored block whose remedy is adding Dealio to the user's apps or a shared server. */
export function needsSharedPlace(config: Pick<UserConfig, 'dmDeliveryErrorCode'>): boolean {
  return config.dmDeliveryErrorCode === 'DISCORD_NO_MUTUAL_GUILD';
}

export function isMinimumDiscountPercent(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

export function isSteamId64(value: string): boolean {
  return /^\d{17}$/.test(value);
}

export function isLanguage(value: string): value is Language {
  return (languages as readonly string[]).includes(value);
}

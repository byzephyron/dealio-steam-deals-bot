import { describe, expect, it } from 'vitest';
import { actionLabel, checkErrorInfo, deliveryErrorInfo, setupFailureReason, setupStepLabel } from '../admin-ui/src/explain.js';

describe('admin panel explanations', () => {
  it('names what a user did from the stored interaction code', () => {
    expect(actionLabel('assistant:tab-games')).toEqual({ label: 'Wishlist sekmesine geçti', area: 'Panel' });
    expect(actionLabel('dealio:check')).toEqual({ label: '“Şimdi kontrol et”e bastı', area: 'Panel' });
    expect(actionLabel('/dealio')).toEqual({ label: '/dealio ile paneli açtı', area: 'Komut' });
    expect(actionLabel('dealio-open:home').area).toBe('DM');
    expect(actionLabel('setup:confirm').label).toBe('Kurulumu onayladı');
    expect(actionLabel('setup-modal:2').label).toBe('Steam profil formunu gönderdi');
    expect(actionLabel('status-threshold-v2:1').label).toBe('Panelde bir formu gönderdi');
    expect(actionLabel('support:close:#').label).toBe('Destek talebini kapattı');
    expect(actionLabel('confirm-ok', 'setup').label).toBe('Kurulumu tamamladı');
  });

  it('keeps an unknown code visible instead of hiding it', () => {
    expect(actionLabel('assistant:brand-new')).toEqual({ label: 'brand-new düğmesine bastı', area: 'Panel' });
    expect(actionLabel('mystery:thing').area).toBe('mystery');
    expect(actionLabel('/legacy').label).toBe('/legacy komutunu kullandı');
  });

  it('explains why Discord refused an alert, from stored codes or Discord’s message', () => {
    expect(deliveryErrorInfo('Cannot send messages to this user due to having no mutual guilds').title).toBe('Ortak sunucu yok');
    expect(deliveryErrorInfo('DISCORD_NO_MUTUAL_GUILD').title).toBe('Ortak sunucu yok');
    expect(deliveryErrorInfo('Cannot send messages to this user')).toMatchObject({ title: 'DM’leri kapalı', fix: 'user' });
    expect(deliveryErrorInfo('50007').title).toBe('DM’leri kapalı');
    expect(deliveryErrorInfo('Internal Server Error')).toMatchObject({ title: 'Discord teslim etmedi', fix: 'owner' });
  });

  it('explains setup failures and check errors in plain words', () => {
    expect(setupStepLabel('prepare-failed:STEAM_WISHLIST_INACCESSIBLE')).toBe('Profil doğrulanamadı: wishlist gizli');
    expect(setupStepLabel('confirm-failed:SetupCapacityReachedError')).toBe('Kurulum onayda başarısız: kayıtlar kapalı / dolu');
    expect(setupFailureReason('prepare-failed:STEAM_WISHLIST_INACCESSIBLE')).toBe('Wishlist gizli');
    expect(setupFailureReason('confirm-failed:STEAM_TIMEOUT')).toBe('Steam yanıt vermedi (onayda)');
    expect(checkErrorInfo('STEAM_WISHLIST_INACCESSIBLE')).toMatchObject({ title: 'Wishlist gizli', fix: 'user' });
    expect(checkErrorInfo('STEAM_TIMEOUT').fix).toBe('temporary');
    expect(checkErrorInfo('SOMETHING_NEW')).toMatchObject({ title: 'Bilinmeyen hata', fix: 'owner' });
  });
});

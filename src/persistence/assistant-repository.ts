import { preparedStatement } from './prepared-statement.js';
import type { NotificationCandidate } from '../domain/wishlist-state.js';

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UserConfig } from '../domain/user-config.js';
import type { WishlistItem, SteamWishlistResult } from '../domain/steam.js';
import { validatePreference, localClock, type NotificationPreference } from '../domain/notification-preference.js';
import { deeperTargetPrice, rebaselineDiscountAlerts } from './alert-levels.js';

type Scope = Pick<UserConfig, 'discordUserId' | 'configVersion' | 'storeCountryCode'>;
export interface GameRule {
  mode: 'inherit' | 'percent' | 'target'; percent: number | null;
  targetMinor: number | null; currency: string | null; muted: boolean; revision: number;
}
export interface HistoryEntry {
  app_id: number; game_name: string; status: string; reason: string;
  created_at: string; delivered_at: string | null; discord_message_id: string | null;
}
export interface PricePoint { final_minor: number; initial_minor: number; observed_at: string }

function previousTargetState(db: DatabaseSync, scope: Scope, appId: number): { event_id: string | null } {
  return (preparedStatement(db,'SELECT event_id FROM game_rule WHERE discord_user_id=? AND config_version=? AND app_id=?')
    .get(scope.discordUserId, scope.configVersion, appId) as { event_id: string | null } | undefined) ?? { event_id: null };
}

export class AssistantRepository {
  constructor(public readonly db: DatabaseSync) {}

  rules(scope: Scope): Map<number, GameRule> {
    const rows = preparedStatement(this.db,`SELECT app_id,mode,percent,target_minor,currency,muted,revision FROM game_rule
      WHERE discord_user_id=? AND config_version=?`).all(scope.discordUserId, scope.configVersion) as unknown as
      {app_id:number; mode:GameRule['mode']; percent:number|null; target_minor:number|null; currency:string|null; muted:number; revision:number}[];
    return new Map(rows.map(r => [r.app_id, {mode:r.mode,percent:r.percent,targetMinor:r.target_minor,
      currency:r.currency,muted:r.muted===1,revision:r.revision}]));
  }

  rule(scope: Scope, appId: number): GameRule | null {
    const r = preparedStatement(this.db,`SELECT mode,percent,target_minor,currency,muted,revision FROM game_rule
      WHERE discord_user_id=? AND config_version=? AND app_id=?`).get(scope.discordUserId, scope.configVersion, appId) as
      {mode: GameRule['mode']; percent: number|null; target_minor: number|null; currency: string|null; muted: number; revision: number} | undefined;
    return r ? {mode:r.mode,percent:r.percent,targetMinor:r.target_minor,currency:r.currency,muted:r.muted===1,revision:r.revision} : null;
  }

  saveRule(scope: Scope, appId: number, rule: Omit<GameRule,'revision'>, now = new Date().toISOString()): void {
    if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('Invalid app');
    if (!['inherit','percent','target'].includes(rule.mode)) throw new Error('Invalid rule');
    if (rule.mode === 'target' && (!Number.isSafeInteger(rule.targetMinor) || rule.targetMinor! < 0 || !/^[A-Z]{3}$/.test(rule.currency ?? '')))
      throw new Error('Invalid target price');
    if (rule.mode === 'percent' && (!Number.isInteger(rule.percent) || rule.percent! < 0 || rule.percent! > 100)) throw new Error('Invalid percent');
    const state = preparedStatement(this.db,`SELECT final_price_minor,currency,observation_status FROM wishlist_item_state
      WHERE discord_user_id=? AND config_version=? AND app_id=?`).get(scope.discordUserId,scope.configVersion,appId);
    const eligible = rule.mode === 'target' && state?.observation_status === 'known' && state.currency === rule.currency
      && typeof state.final_price_minor === 'number' && state.final_price_minor <= rule.targetMinor!;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A target already met today is the baseline: it alerts after a clearly lower price, or a new crossing.
      preparedStatement(this.db,`INSERT INTO game_rule(discord_user_id,config_version,app_id,mode,percent,target_minor,currency,muted,updated_at,eligible,initialized,alerted_minor)
        SELECT discord_user_id,config_version,?,?,?,?,?,?,?,?,?,? FROM user_config WHERE discord_user_id=? AND config_version=?
        ON CONFLICT(discord_user_id,config_version,app_id) DO UPDATE SET
        mode=excluded.mode,percent=excluded.percent,target_minor=excluded.target_minor,currency=excluded.currency,muted=excluded.muted,
        revision=game_rule.revision+1,eligible=excluded.eligible,initialized=excluded.initialized,event_id=NULL,
        alerted_minor=excluded.alerted_minor,updated_at=excluded.updated_at`)
        .run(appId,rule.mode,rule.percent,rule.targetMinor,rule.currency,rule.muted?1:0,now,eligible?1:0,state?.observation_status==='known'?1:0,
          eligible?state.final_price_minor as number:null,scope.discordUserId,scope.configVersion);
      preparedStatement(this.db,'DELETE FROM game_discount_threshold WHERE discord_user_id=? AND config_version=? AND app_id=?')
        .run(scope.discordUserId,scope.configVersion,appId);
      if (rule.mode === 'percent') preparedStatement(this.db,`INSERT INTO game_discount_threshold VALUES (?,?,?,?,?)`)
        .run(scope.discordUserId,scope.configVersion,appId,rule.percent,now);
      preparedStatement(this.db,`UPDATE wishlist_item_state SET rule_event_id=NULL WHERE discord_user_id=? AND config_version=? AND app_id=?`)
        .run(scope.discordUserId,scope.configVersion,appId);
      // Target alerts belong to the old rule; discount alerts are re-judged like a default-threshold change.
      this.expireGame(scope,appId,'Rule changed','target');
      if (rule.muted) this.expireGame(scope,appId,'Game muted');
      rebaselineDiscountAlerts(this.db,scope,{appId});
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }

  private expireGame(scope: Scope, appId: number, reason: string, kind: 'all' | 'target' = 'all'): void {
    const onlyTargets = kind === 'target' ? "AND reason LIKE 'target:%'" : '';
    // Retire the entire retry envelope before changing one member; valid siblings can be replanned.
    preparedStatement(this.db,`UPDATE notification_batch SET status='expired',next_attempt_at=NULL WHERE status='failed' AND batch_id IN
      (SELECT item.batch_id FROM notification_batch_item AS item JOIN notification_log AS notification
         ON notification.discord_user_id=item.discord_user_id AND notification.config_version=item.config_version
        AND notification.app_id=item.app_id AND notification.sale_episode_id=item.sale_episode_id
       WHERE item.discord_user_id=? AND item.config_version=? AND item.app_id=? ${onlyTargets.replace('reason','notification.reason')})`)
      .run(scope.discordUserId,scope.configVersion,appId);
    preparedStatement(this.db,`UPDATE notification_log SET status='expired',next_attempt_at=NULL,last_error=?
      WHERE discord_user_id=? AND config_version=? AND app_id=? AND status IN ('candidate','failed') ${onlyTargets}`)
      .run(reason,scope.discordUserId,scope.configVersion,appId);
  }

  observe(scope: Scope & {steamId64:string}, item: WishlistItem, now: string, baseline=false): NotificationCandidate | null {
    const price = item.price;
    if (!price || !price.currency) return null;
    const observedAt = item.priceObservedAt ?? now;
    const last = preparedStatement(this.db,`SELECT final_minor,initial_minor,observed_at FROM price_observation
      WHERE app_id=? AND country=? AND currency=? ORDER BY observed_at DESC,id DESC LIMIT 1`)
      .get(item.appId,scope.storeCountryCode,price.currency);
    if (!last || (String(last.observed_at) < observedAt && (last.final_minor !== price.finalMinor || last.initial_minor !== price.initialMinor))) {
      preparedStatement(this.db,'INSERT INTO price_observation(app_id,country,currency,initial_minor,final_minor,observed_at) VALUES (?,?,?,?,?,?)')
        .run(item.appId,scope.storeCountryCode,price.currency,price.initialMinor,price.finalMinor,observedAt);
    }
    const rule = this.rule(scope,item.appId);
    if (!rule) return null;
    if (rule.muted) this.expireGame(scope,item.appId,'Game muted');
    if (rule.mode !== 'target') return null;
    // A target saved in another currency (the Store region changed) waits for a new
    // target; until then the default discount rule covers the game.
    if (price.currency !== rule.currency) {
      if (previousTargetState(this.db, scope, item.appId).event_id !== null) {
        this.expireGame(scope,item.appId,'Target currency changed','target');
        preparedStatement(this.db,`UPDATE game_rule SET eligible=0,event_id=NULL,alerted_minor=NULL WHERE discord_user_id=? AND config_version=? AND app_id=?`)
          .run(scope.discordUserId,scope.configVersion,item.appId);
        preparedStatement(this.db,`UPDATE wishlist_item_state SET rule_event_id=NULL WHERE discord_user_id=? AND config_version=? AND app_id=?`)
          .run(scope.discordUserId,scope.configVersion,item.appId);
      }
      return null;
    }
    const previous = preparedStatement(this.db,'SELECT eligible,initialized,event_id,alerted_minor FROM game_rule WHERE discord_user_id=? AND config_version=? AND app_id=?')
      .get(scope.discordUserId,scope.configVersion,item.appId)!;
    const eligible = !rule.muted && price.finalMinor <= rule.targetMinor!;
    const previousEvent = previous.event_id as string|null;
    const waiting = previousEvent !== null && preparedStatement(this.db,`SELECT 1 FROM notification_log WHERE discord_user_id=? AND config_version=?
      AND app_id=? AND sale_episode_id=? AND status IN ('candidate','failed')`).get(scope.discordUserId,scope.configVersion,item.appId,previousEvent) !== undefined;
    const tracked = !baseline && previous.initialized === 1 && eligible;
    const crossing = tracked && previous.eligible === 0;
    // Already under the target: a clearly lower price is worth another alert.
    const deeper = tracked && previous.eligible === 1 && !waiting
      && deeperTargetPrice(price.finalMinor, previous.alerted_minor as number | null);
    const fresh = crossing || deeper;
    const event = fresh ? randomUUID() : eligible ? previousEvent : null;
    const alertedMinor = !eligible ? null
      : fresh || waiting ? price.finalMinor : (previous.alerted_minor as number | null) ?? price.finalMinor;
    preparedStatement(this.db,`UPDATE game_rule SET eligible=?,initialized=1,event_id=?,alerted_minor=? WHERE discord_user_id=? AND config_version=? AND app_id=?`)
      .run(eligible?1:0,event,alertedMinor,scope.discordUserId,scope.configVersion,item.appId);
    preparedStatement(this.db,`UPDATE wishlist_item_state SET rule_event_id=? WHERE discord_user_id=? AND config_version=? AND app_id=?`)
      .run(event,scope.discordUserId,scope.configVersion,item.appId);
    if (!eligible) this.expireGame(scope,item.appId,'Target no longer met or currency changed');
    if (fresh && event) {
      preparedStatement(this.db,`INSERT INTO notification_log(discord_user_id,steam_id64,config_version,store_country_code,app_id,sale_episode_id,
        sale_key,game_name,currency,normal_price_minor,final_price_minor,discount_percent,created_at,rule_revision,reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.discordUserId,scope.steamId64,scope.configVersion,scope.storeCountryCode,item.appId,event,
          'target:'+event,item.name,price.currency,price.initialMinor,price.finalMinor,price.discountPercent,now,rule.revision,
          'target:'+String(rule.targetMinor)+':'+rule.currency);
      return {discordUserId:scope.discordUserId,steamId64:scope.steamId64,configVersion:scope.configVersion,storeCountryCode:scope.storeCountryCode,
        appId:item.appId,saleEpisodeId:event,saleKey:'target:'+event,gameName:item.name,currency:price.currency,normalPriceMinor:price.initialMinor,
        finalPriceMinor:price.finalMinor,discountPercent:price.discountPercent,createdAt:now,attemptCount:0,reason:'target:'+rule.targetMinor+':'+rule.currency};
    } else if (eligible && event) {
      preparedStatement(this.db,`UPDATE notification_log SET normal_price_minor=?,final_price_minor=?,discount_percent=? WHERE
        discord_user_id=? AND config_version=? AND app_id=? AND sale_episode_id=? AND status IN ('candidate','failed')`)
        .run(price.initialMinor,price.finalMinor,price.discountPercent,scope.discordUserId,scope.configVersion,item.appId,event);
    }
    return null;
  }

  /**
   * One snapshot per user: the latest wishlist read. A language change keeps showing
   * it (names in the previous language) until the next check, instead of an empty
   * panel; older snapshots, other languages and old account versions are dropped.
   */
  saveSnapshot(config: UserConfig, result: SteamWishlistResult, capturedAt: string): void {
    preparedStatement(this.db,`INSERT INTO wishlist_snapshot VALUES (?,?,?,?,?) ON CONFLICT(discord_user_id,config_version,language)
      DO UPDATE SET captured_at=excluded.captured_at,payload=excluded.payload`)
      .run(config.discordUserId,config.configVersion,config.language,capturedAt,JSON.stringify(result));
    preparedStatement(this.db,'DELETE FROM wishlist_snapshot WHERE discord_user_id=? AND NOT (config_version=? AND language=?)')
      .run(config.discordUserId,config.configVersion,config.language);
  }
  snapshot(config: UserConfig): (SteamWishlistResult & {capturedAt:string; language:string}) | null {
    const r=preparedStatement(this.db,`SELECT payload,captured_at,language FROM wishlist_snapshot WHERE discord_user_id=? AND config_version=?
      ORDER BY language=? DESC, captured_at DESC LIMIT 1`)
      .get(config.discordUserId,config.configVersion,config.language);
    return r ? {...JSON.parse(String(r.payload)) as SteamWishlistResult,capturedAt:String(r.captured_at),language:String(r.language)} : null;
  }
  preference(user: string): NotificationPreference {
    const r=preparedStatement(this.db,'SELECT * FROM notification_preference WHERE discord_user_id=?').get(user);
    return r ? {mode:r.mode as NotificationPreference['mode'],timezone:r.timezone as string|null,quietStart:r.quiet_start as number|null,
      quietEnd:r.quiet_end as number|null,digestMinute:r.digest_minute as number|null,lastDigestDate:r.last_digest_date as string|null}
      : {mode:'instant',timezone:null,quietStart:null,quietEnd:null,digestMinute:null};
  }
  savePreference(user: string, p: NotificationPreference): void {
    validatePreference(p);
    preparedStatement(this.db,`INSERT INTO notification_preference(discord_user_id,mode,timezone,quiet_start,quiet_end,digest_minute)
      VALUES (?,?,?,?,?,?) ON CONFLICT(discord_user_id) DO UPDATE SET mode=excluded.mode,timezone=excluded.timezone,
      quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,digest_minute=excluded.digest_minute`)
      .run(user,p.mode,p.timezone,p.quietStart,p.quietEnd,p.digestMinute);
  }
  markDigest(user: string, now: Date): void {
    const p=this.preference(user);
    if(p.mode==='digest' && p.timezone) preparedStatement(this.db,'UPDATE notification_preference SET last_digest_date=? WHERE discord_user_id=?')
      .run(localClock(now,p.timezone).date,user);
  }

  history(user:string,now=new Date()): HistoryEntry[] {
    return preparedStatement(this.db,`SELECT app_id,game_name,CASE WHEN status='terminal_failed' AND last_error IN ('DISCORD_DM_BLOCKED','DISCORD_NO_MUTUAL_GUILD') THEN 'blocked' ELSE status END status,reason,created_at,delivered_at,discord_message_id FROM notification_log
      WHERE discord_user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 30`)
      .all(user,new Date(now.getTime()-30*86400000).toISOString()) as unknown as HistoryEntry[];
  }
  prices(appId:number,country:string,currency:string,now=new Date()): PricePoint[] {
    return preparedStatement(this.db,`SELECT final_minor,initial_minor,observed_at FROM price_observation WHERE app_id=? AND country=? AND currency=?
      AND observed_at>=? ORDER BY observed_at`).all(appId,country,currency,new Date(now.getTime()-90*86400000).toISOString()) as unknown as PricePoint[];
  }
  cleanup(now=new Date()): void {
    preparedStatement(this.db,'DELETE FROM price_observation WHERE observed_at < ?').run(new Date(now.getTime()-90*86400000).toISOString());
    // A Steam account or Store region change starts a new generation; nothing reads the
    // earlier ones again. Their per-game state (with the old Steam ID) would otherwise stay
    // forever and keep that generation's alert history from ever ageing out below.
    for (const table of ['wishlist_item_state','game_rule','game_discount_threshold']) {
      preparedStatement(this.db,`DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM user_config AS config
        WHERE config.discord_user_id=${table}.discord_user_id AND config.config_version=${table}.config_version)`).run();
    }
    // Hide old history immediately, retain dedup for every active offer and all unresolved deliveries.
    preparedStatement(this.db,`DELETE FROM notification_batch WHERE status IN ('sent','expired','terminal_failed') AND created_at<?
      AND NOT EXISTS (SELECT 1 FROM notification_batch_item i JOIN notification_log n ON n.discord_user_id=i.discord_user_id
        AND n.config_version=i.config_version AND n.app_id=i.app_id AND n.sale_episode_id=i.sale_episode_id
        JOIN wishlist_item_state s ON s.discord_user_id=n.discord_user_id AND s.config_version=n.config_version AND s.app_id=n.app_id
        WHERE i.batch_id=notification_batch.batch_id AND (s.sale_episode_id=n.sale_episode_id OR s.rule_event_id=n.sale_episode_id))`)
      .run(new Date(now.getTime()-30*86400000).toISOString());
    preparedStatement(this.db,`DELETE FROM notification_log AS n WHERE status IN ('sent','expired','terminal_failed') AND created_at<?
      AND NOT EXISTS (SELECT 1 FROM wishlist_item_state s WHERE s.discord_user_id=n.discord_user_id AND s.config_version=n.config_version
        AND s.app_id=n.app_id AND (s.sale_episode_id=n.sale_episode_id OR s.rule_event_id=n.sale_episode_id))
      AND NOT EXISTS (SELECT 1 FROM notification_batch_item i WHERE i.discord_user_id=n.discord_user_id AND i.config_version=n.config_version
        AND i.app_id=n.app_id AND i.sale_episode_id=n.sale_episode_id)`).run(new Date(now.getTime()-30*86400000).toISOString());
  }
}

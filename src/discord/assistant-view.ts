import { artworkAccessory, addArtwork } from './ui/game-artwork.js';

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, SectionBuilder, SeparatorBuilder,
  SeparatorSpacingSize, StringSelectMenuBuilder, TextDisplayBuilder, escapeMarkdown } from 'discord.js';
import type { WishlistItem, WishlistItemError } from '../domain/steam.js';
import type { UserConfig } from '../domain/user-config.js';
import type { GameRule, HistoryEntry } from '../persistence/assistant-repository.js';
import type { NotificationPreference } from '../domain/notification-preference.js';
import type { GameHistory } from '../domain/price-history.js';
import { formatMinorPrice, sanitizeGameName } from './notification-messages.js';
import { messagesFor } from './messages.js';
import { defaultPollIntervalHours } from '../config/environment.js';
import { historicalLowLine, priceChangeLine, priceHistoryCredit } from './price-history-text.js';
import { assertComponentsV2Limit, dealioFooter } from './ui/components-v2.js';
import {
  comingSoon, countryDisplay, freeToKeepLine, hotDealPercent, hotPrefix, noPriceText, panelHeader, panelKicker, platformText, priceFetched,
  priceLine, releaseDateText, reviewLine, saleEndLine, savingsLine, steamAppLabel, steamAppUrl, tabAccent, unavailableGamesLine,
} from './ui/design.js';
import { localizer, percentOff, percentText } from './i18n.js';
import { buildTabBar } from './ui/tab-bar.js';
import { defaultTimezone, timezoneChoices, timezoneLabel } from '../domain/timezone.js';

export interface AssistantView {
  screen:'wishlist'|'detail'|'history'|'rhythm'; page:number; query:string; eligibleOnly:boolean;
  selectedAppId?:number; notice?:string; refreshing?:boolean;
}
export interface AssistantViewData {
  config:UserConfig; items:readonly WishlistItem[]; capturedAt:string;
  rules:ReadonlyMap<number,GameRule>; preference:NotificationPreference; history:HistoryEntry[];
  /** Absent when price history is not configured; the detail panel then omits the section. */
  priceHistory?:GameHistoryState;
  /** Steam's item errors from the same wishlist read; region-locked and removed games are listed as facts. */
  errors?:readonly WishlistItemError[];
  /** The configured check interval; the default when not given. */
  pollIntervalHours?:number;
}
export type GameHistoryState={status:'loading'}|{status:'ready';history:GameHistory|null};
const text=(value:string)=>new TextDisplayBuilder().setContent(value);
/** A Steam name as plain text: no masked links, mentions or headings, and no escape cut in half. */
const gameName=(name:string,max:number)=>sanitizeGameName(name.slice(0,max));
const button=(id:string,label:string,emoji?:string,primary=false)=>{
  const control=new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(primary?ButtonStyle.Primary:ButtonStyle.Secondary);
  return emoji?control.setEmoji(emoji):control;
};
/** The saved time zone, else the Store region's own zone; null when the user must choose. */
export function effectiveTimezone(data:Pick<AssistantViewData,'preference'|'config'>):string|null {
  return data.preference.timezone??defaultTimezone(data.config.storeCountryCode);
}
const clock=(minute:number|null)=>minute===null?'—':String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
const relative=(value:string)=>`<t:${Math.floor(Date.parse(value)/1000)}:R>`;
/** A target saved in another currency than Steam's current price (the Store region changed). */
export function staleTarget(item:WishlistItem,rule:GameRule|undefined):boolean {
  return rule?.mode==='target' && Boolean(item.price?.currency) && item.price!.currency!==rule.currency;
}
/** Mirrors the alert rule: a target in the price's currency, else the game's or the default discount. */
export function matchesRule(item:WishlistItem,rule:GameRule|undefined,global:number):boolean {
  if(rule?.muted || !item.price || !item.price.currency) return false;
  if(rule?.mode==='target' && !staleTarget(item,rule)) return item.price.finalMinor<=rule.targetMinor!;
  return item.onSale===true && item.price.discountPercent>0
    && item.price.discountPercent>=(rule?.mode==='percent'?rule.percent!:global);
}
/** "N hedef fiyatın eski para biriminde…": shown on Home and Wishlist after a region change. */
export function staleTargetsNotice(count:number,lang:UserConfig['language']):string {
  const one=count===1;
  return '⚠️ '+localizer(lang)({
    tr:`**${count}** oyunun hedef fiyatı eski para biriminde. Yenisini kaydedene kadar bu oyunlarda genel indirim kuralın geçerli.`,
    en:`**${count}** ${one?'game has a target':'games have targets'} in an old currency. Until you save new ones, your default discount rule applies to ${one?'it':'them'}.`,
    de:`**${count}** ${one?'Spiel hat einen Wunschpreis':'Spiele haben Wunschpreise'} in einer alten Währung. Bis du neue speicherst, gilt dort deine Standardregel.`,
    fr:`**${count}** ${one?'jeu a un prix cible':'jeux ont des prix cibles'} dans une ancienne devise. Jusqu’à ce que tu en enregistres de nouveaux, ta règle par défaut s’applique.`,
  });
}
/**
 * The list order: deals that match the user's rule first, then other discounts,
 * each by the deepest discount; everything else keeps Steam's wishlist order.
 */
export function filteredAssistantItems(data:AssistantViewData,view:AssistantView):WishlistItem[] {
  const rank=(item:WishlistItem)=>matchesRule(item,data.rules.get(item.appId),data.config.minimumDiscountPercent)?0:item.onSale===true?1:2;
  return data.items
    .map((item,index)=>({item,index,rank:rank(item),discount:item.price?.discountPercent??0}))
    .filter(({item})=>item.name.toLocaleLowerCase(data.config.language).includes(view.query.toLocaleLowerCase(data.config.language))
      && (!view.eligibleOnly || matchesRule(item,data.rules.get(item.appId),data.config.minimumDiscountPercent)))
    .sort((a,b)=>a.rank-b.rank||(a.rank<2?b.discount-a.discount:0)||a.index-b.index)
    .map(({item})=>item);
}
function pricedItem(item:WishlistItem){
  const p=item.price;
  return p?.currency?{finalMinor:p.finalMinor,initialMinor:p.initialMinor,discountPercent:p.discountPercent,currency:p.currency}:null;
}
export function buildAssistantView(data:AssistantViewData,view:AssistantView,session:string,disabled=false):ContainerBuilder {
  const lang=data.config.language, t=localizer(lang), prefix='assistant:'+session+':';
  const games=view.screen==='wishlist'||view.screen==='detail';
  const root=new ContainerBuilder().setAccentColor(tabAccent[games?'games':'alerts']);
  const add=(value:string)=>root.addTextDisplayComponents(text(value));
  const gap=()=>root.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
  const divider=()=>root.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
  const price=(minor:number,currency:string)=>formatMinorPrice(minor,currency,lang);
  const defaultRuleText=()=>{
    const percent=percentText(data.config.minimumDiscountPercent,lang);
    return t({tr:`En az ${percent} indirim`,en:`At least ${percent} off`,de:`Mindestens ${percent} Rabatt`,fr:`Au moins ${percent} de réduction`});
  };
  const ruleText=(rule:GameRule|undefined,item?:WishlistItem)=>{
    if(rule?.muted) return '🔕 '+t({tr:'Sessizde',en:'Muted',de:'Stummgeschaltet',fr:'En sourdine'});
    if(item && staleTarget(item,rule)){
      const target=price(rule!.targetMinor!,rule!.currency!);
      return '⚠️ '+t({
        tr:`Hedefin (${target}) eski para biriminde; yenisini kaydedene kadar genel kuralın geçerli: ${defaultRuleText()}`,
        en:`Your target (${target}) is in an old currency; until you save a new one, your default applies: ${defaultRuleText()}`,
        de:`Dein Wunschpreis (${target}) ist in einer alten Währung; bis du einen neuen speicherst, gilt deine Standardregel: ${defaultRuleText()}`,
        fr:`Ton prix cible (${target}) est dans une ancienne devise ; jusqu’à ce que tu en enregistres un nouveau, ta règle par défaut s’applique : ${defaultRuleText()}`,
      });
    }
    if(rule?.mode==='target'){
      const target=price(rule.targetMinor!,rule.currency!);
      return '🎯 '+t({tr:`Hedef fiyat: ${target}`,en:`Target: ${target}`,de:`Wunschpreis: ${target}`,fr:`Prix cible : ${target}`});
    }
    const percent=percentText(rule?.mode==='percent'?rule.percent!:data.config.minimumDiscountPercent,lang);
    return '🏷️ '+t({tr:`En az ${percent} indirim`,en:`At least ${percent} off`,de:`Mindestens ${percent} Rabatt`,fr:`Au moins ${percent} de réduction`})
      +(rule?.mode==='percent'?'':' '+t({tr:'(genel ayarın)',en:'(your default)',de:'(deine Standardregel)',fr:'(ta règle par défaut)'}));
  };
  const notice=()=>{if(view.notice) add('> '+escapeMarkdown(view.notice).slice(0,250));};
  const previous=t({tr:'Önceki',en:'Previous',de:'Zurück',fr:'Précédent'}), next=t({tr:'Sonraki',en:'Next',de:'Weiter',fr:'Suivant'});

  if(view.screen==='wishlist'){
    const items=filteredAssistantItems(data,view), pages=Math.max(1,Math.ceil(items.length/3));
    const page=Math.min(Math.max(0,view.page),pages-1), visible=items.slice(page*3,page*3+3);
    const count=data.items.filter(i=>matchesRule(i,data.rules.get(i.appId),data.config.minimumDiscountPercent)).length;
    const upcoming=data.items.filter(i=>i.upcoming&&!i.price).length;
    const staleTargets=data.items.filter(i=>staleTarget(i,data.rules.get(i.appId))).length;
    add(panelHeader('games',lang,t({tr:'İstek listen ve hedeflerin',en:'Your wishlist & targets',de:'Deine Wunschliste & Wunschpreise',fr:'Ta liste et tes prix cibles'}),
      `✅ **${count}** ${t({tr:'oyun kuralına uyuyor',en:'matching deals',de:'passende Angebote',fr:'bons plans pour toi'})}`+
      `　🎮 **${data.items.length}** ${t({tr:'oyun',en:'games',de:'Spiele',fr:'jeux'})}`+
      (upcoming?`　🗓️ **${upcoming}** ${t({tr:'yakında çıkacak',en:'coming soon',de:'erscheinen bald',fr:'à venir'})}`:'')+
      `　${countryDisplay(data.config.storeCountryCode,lang)}`)+
      '\n-# ↕️ '+t({tr:'Önce kuralına uyanlar, sonra en büyük indirimler',en:'Matching deals first, then the biggest discounts',
        de:'Passende Angebote zuerst, dann die größten Rabatte',fr:'D’abord les bons plans pour toi, puis les plus grosses réductions'})+
      '\n-# 🕒 '+priceFetched(relative(data.items.map(i=>i.priceObservedAt??data.capturedAt).sort()[0]??data.capturedAt),lang,true)+
      (view.refreshing?' · '+t({tr:'Steam’den yeniliyorum…',en:'Refreshing from Steam…',de:'Aktualisiere von Steam …',fr:'Actualisation depuis Steam…'}):''));
    notice();
    if(staleTargets&&!view.query) add('> '+staleTargetsNotice(staleTargets,lang));
    if(view.query) add('🔍 '+t({tr:'Arama: ',en:'Search: ',de:'Suche: ',fr:'Recherche : '})+'**'+escapeMarkdown(view.query)+'**');
    divider();
    visible.forEach((item,index)=>{
      if(index>0) gap();
      const rule=data.rules.get(item.appId), p=pricedItem(item);
      const matches=matchesRule(item,rule,data.config.minimumDiscountPercent);
      root.addSectionComponents(artworkAccessory(new SectionBuilder().addTextDisplayComponents(text(
        `### ${hotPrefix(p?.discountPercent)}${gameName(item.name,100)}\n${p?priceLine(p,lang):noPriceText(item,lang)}\n`+
        `-# ${ruleText(rule,item)}${matches?' · ✅ '+t({tr:'Kuralına uyuyor',en:'Matches your rule',de:'Passt zu deiner Regel',fr:'Correspond à ta règle'}):''}`)), item));
    });
    const unavailable=unavailableGamesLine(data.errors,data.config.storeCountryCode,lang);
    if(unavailable&&!view.query&&!view.eligibleOnly&&page===pages-1) { gap(); add('-# '+unavailable); }
    if(!visible.length) add('🫥 '+t({
      tr:'Burada gösterecek oyun yok. Aramayı ya da filtreyi temizleyebilirsin.',
      en:'No games here. Clear the search or the filter.',
      de:'Hier gibt es keine Spiele. Setz die Suche oder den Filter zurück.',
      fr:'Aucun jeu ici. Efface la recherche ou le filtre.',
    }));
    divider();
    if(visible.length) root.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(prefix+'game').setPlaceholder('🎮 '+t({
        tr:'Bir oyun aç · hedef fiyat ve fiyat geçmişi',
        en:'Open a game · target and price history',
        de:'Spiel öffnen · Wunschpreis und Preisverlauf',
        fr:'Ouvrir un jeu · prix cible et historique',
      }))
        .setDisabled(disabled).addOptions(visible.map(item=>{
          const p=pricedItem(item);
          return {label:item.name.slice(0,100),value:String(item.appId),
            emoji:!p&&item.upcoming?'🗓️':(p?.discountPercent??0)>=hotDealPercent?'🔥':matchesRule(item,data.rules.get(item.appId),data.config.minimumDiscountPercent)?'🎯':item.onSale?'🏷️':'🎮',
            ...(p?{description:(price(p.finalMinor,p.currency)+(p.discountPercent>0?' · '+percentOff(p.discountPercent,lang):'')).slice(0,100)}
              :item.upcoming?{description:(comingSoon[lang]+' · '+releaseDateText(item.upcoming,lang)).slice(0,100)}:{})};
        }))));
    root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(prefix+'search',t({tr:'Oyun ara',en:'Search',de:'Suchen',fr:'Rechercher'}),'🔍'),
      button(prefix+'filter',view.eligibleOnly?t({tr:'Tüm oyunlar',en:'All games',de:'Alle Spiele',fr:'Tous les jeux'})
        :t({tr:'Kuralıma uyanlar',en:'Matching deals',de:'Passende Angebote',fr:'Bons plans pour moi'}),view.eligibleOnly?'📋':'✅'),
      button(prefix+'refresh',t({tr:'Yenile',en:'Refresh',de:'Aktualisieren',fr:'Actualiser'}),'🔄').setDisabled(disabled||view.refreshing===true)));
    if(pages>1) root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(prefix+'prev',previous,'◀️').setDisabled(disabled||page===0),
      button(prefix+'page',`${page+1} / ${pages}`).setDisabled(true),
      button(prefix+'next',next,'▶️').setDisabled(disabled||page===pages-1)));
  } else if(view.screen==='detail'){
    const item=data.items.find(i=>i.appId===view.selectedAppId);
    const backToList=t({tr:'Listeye dön',en:'Back to list',de:'Zurück zur Liste',fr:'Retour à la liste'});
    if(!item){
      add(panelHeader('games',lang,t({tr:'Bu oyunu bulamadım',en:'I can’t find that game',de:'Dieses Spiel finde ich nicht',fr:'Je ne trouve pas ce jeu'}),
        t({
          tr:'Kayıtlı istek listende artık yok. Listeye dönüp yenileyebilirsin.',
          en:'It’s no longer in your saved wishlist. Go back and refresh.',
          de:'Es ist nicht mehr auf deiner gespeicherten Wunschliste. Geh zurück und aktualisiere.',
          fr:'Il n’est plus dans ta liste enregistrée. Reviens en arrière et actualise.',
        })));
      root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(button(prefix+'wishlist',backToList,'◀️')));
    } else{
      const p=pricedItem(item),rule=data.rules.get(item.appId);
      add(panelKicker('games',lang));
      addArtwork(root, item);
      const facts=item.storeFacts;
      add(['# '+hotPrefix(p?.discountPercent)+gameName(item.name,120),
        p?priceLine(p,lang):noPriceText(item,lang),
        p&&freeToKeepLine(p,lang), p&&savingsLine(p,lang), item.onSale?saleEndLine(facts,lang):null, reviewLine(facts,lang),
        '-# '+['🕒 '+priceFetched(relative(item.priceObservedAt??data.capturedAt),lang),
          platformText(facts)].filter(Boolean).join(' · '),
      ].filter(Boolean).join('\n'));
      notice();
      divider();
      const eligible=matchesRule(item,rule,data.config.minimumDiscountPercent);
      const targetRule=rule?.mode==='target'&&!staleTarget(item,rule);
      add('### 🎯 '+t({tr:'Kuralın',en:'Your rule',de:'Deine Regel',fr:'Ta règle'})+'\n'+ruleText(rule,item)+'\n'+
        (eligible?'✅ '+(targetRule?t({
          tr:'Şu anki fiyat hedefine uyuyor. Bunun için ayrıca DM atmam; fiyat bundan %10 daha düşerse ya da hedefinin üstüne çıkıp yeniden inerse haber veririm.',
          en:'Today’s price already meets your target. I won’t DM you about it, but I will if the price drops another 10% or rises above your target and comes back.',
          de:'Der aktuelle Preis erfüllt deinen Wunschpreis schon. Dafür schicke ich keine DM, aber wenn er um weitere 10 % fällt oder über deinen Wunschpreis steigt und zurückkommt.',
          fr:'Le prix actuel atteint déjà ton prix cible. Je ne t’envoie pas de MP pour ça, mais oui s’il baisse encore de 10 % ou s’il repasse au-dessus de ta cible puis redescend.',
        }):t({
          tr:'Şu anki indirim kuralına uyuyor. Bunun için ayrıca DM atmam; indirim en az 10 puan daha artarsa haber veririm.',
          en:'Today’s discount already meets your rule. I won’t DM you about it, but I will if the discount grows by at least 10 more points.',
          de:'Der aktuelle Rabatt erfüllt deine Regel schon. Dafür schicke ich keine DM, aber wenn er um mindestens 10 weitere Punkte steigt.',
          fr:'La réduction actuelle respecte déjà ta règle. Je ne t’envoie pas de MP pour ça, mais oui si elle augmente d’au moins 10 points.',
        })):'⏳ '+t({
          tr:'Fiyat kuralına uyduğu an sana DM atacağım.',
          en:'I’ll DM you as soon as the price meets your rule.',
          de:'Sobald der Preis zu deiner Regel passt, schicke ich dir eine DM.',
          fr:'Je t’envoie un MP dès que le prix respecte ta règle.',
        })));
      const history=data.priceHistory;
      const low=history?.status==='ready'?history.history?.low:undefined;
      // The rule in force is highlighted, so the three choices read as one setting.
      const activeMode=rule?.mode??'inherit';
      root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(prefix+'inherit',t({tr:'Genel ayarım',en:'Use default',de:'Standardregel',fr:'Règle par défaut'}),'♻️',activeMode==='inherit'),
        button(prefix+'percent',t({tr:'İndirim oranı',en:'Discount %',de:'Rabatt in %',fr:'Réduction en %'}),'🏷️',activeMode==='percent'),
        button(prefix+'target',t({tr:'Hedef fiyat',en:'Target price',de:'Wunschpreis',fr:'Prix cible'}),'🎯',activeMode==='target').setDisabled(disabled||!p),
        // One tap: a target at the recorded Steam low in the current currency.
        ...(low&&p&&low.currency===p.currency?[button(prefix+'low',t({
          tr:'En düşüğe inince haber ver',en:'Alert me at the lowest',de:'Beim Tiefstpreis melden',fr:'Me prévenir au plus bas',
        }),'🏆')]:[])));
      if(history&&p){
        divider();
        add('### 📈 '+t({tr:'Steam fiyat geçmişi',en:'Steam price history',de:'Steam-Preisverlauf',fr:'Historique des prix Steam'}));
        if(history.status==='loading') add('⏳ '+t({tr:'Fiyat geçmişini getiriyorum…',en:'Loading price history…',de:'Lade Preisverlauf …',fr:'Chargement de l’historique…'}));
        else if(!history.history) add('⚠️ '+t({
          tr:'Fiyat geçmişini şu an alamadım.',en:'Price history isn’t available right now.',
          de:'Der Preisverlauf ist gerade nicht verfügbar.',fr:'L’historique des prix est indisponible pour l’instant.',
        }));
        else {
          const low=history.history.low&&historicalLowLine(p.finalMinor,p.currency,history.history.low,lang);
          add(low??('📭 '+t({
            tr:'Bu bölge için henüz Steam fiyat geçmişi yok.',en:'No Steam price history for this region yet.',
            de:'Für diese Region gibt es noch keinen Steam-Preisverlauf.',fr:'Pas encore d’historique de prix Steam pour cette région.',
          })));
          if(history.history.recent.length) add('**'+t({
            tr:'Son fiyat değişiklikleri',en:'Recent price changes',de:'Letzte Preisänderungen',fr:'Derniers changements de prix',
          })+'**\n'+history.history.recent.map(change=>priceChangeLine(change,lang)).join('\n'));
          add(priceHistoryCredit(lang));
        }
      }
      divider();
      root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(prefix+'wishlist',backToList,'◀️'),
        button(prefix+'mute',rule?.muted?t({tr:'Sessizden çıkar',en:'Unmute',de:'Stumm aus',fr:'Réactiver'})
          :t({tr:'Bu oyunu sustur',en:'Mute game',de:'Spiel stummschalten',fr:'Mettre en sourdine'}),rule?.muted?'🔔':'🔕')));
      root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL('https://store.steampowered.com/app/'+item.appId).setEmoji('🛒').setLabel(messagesFor(lang).openSteamStore),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(steamAppUrl(item.appId)).setEmoji('🖥️').setLabel(steamAppLabel[lang])));
    }
  } else if(view.screen==='history'){
    // The history holds at most the 30 newest alerts of those 30 days (AssistantRepository.history).
    add(panelHeader('alerts',lang,t({tr:'Bildirim geçmişin',en:'Your alert history',de:'Dein Benachrichtigungsverlauf',fr:'Ton historique d’alertes'}),
      '-# '+t({
        tr:'Son 30 günden en fazla 30 bildirim. “Discord’a iletildi”, mesajın okunduğu anlamına gelmez.',
        en:'Up to 30 latest alerts from the last 30 days. “Delivered to Discord” doesn’t mean it was read.',
        de:'Bis zu 30 neueste Benachrichtigungen der letzten 30 Tage. „An Discord zugestellt“ heißt nicht, dass sie gelesen wurde.',
        fr:'Jusqu’à 30 alertes récentes des 30 derniers jours. « Remis à Discord » ne veut pas dire lu.',
      })));
    notice();
    divider();
    const start=Math.max(0,view.page)*5, entries=data.history.slice(start,start+5);
    entries.forEach((h,index)=>{
      if(index>0) gap();
      const status=h.status==='sent'?['✅',t({tr:'Discord’a iletildi',en:'Delivered to Discord',de:'An Discord zugestellt',fr:'Remis à Discord'})]:
        h.status==='expired'?['⌛',t({tr:'Süresi geçti',en:'Expired',de:'Abgelaufen',fr:'Expiré'})]:
        h.status==='blocked'?['🚫',t({tr:'DM engellendi',en:'DM blocked',de:'DM blockiert',fr:'MP bloqué'})]
        :h.status==='terminal_failed'?['❌',t({tr:'İletilemedi',en:'Couldn’t be delivered',de:'Nicht zustellbar',fr:'Non distribué'})]
        :['⏳',t({tr:'Sırada',en:'Waiting',de:'Wartet',fr:'En attente'})];
      const why=h.reason.startsWith('target:')
        ?'🎯 '+t({tr:'Hedef fiyatına ulaştı',en:'Your target price was reached',de:'Dein Wunschpreis wurde erreicht',fr:'Ton prix cible est atteint'})
        :'🏷️ '+t({tr:'İndirim kuralına uydu',en:'Your discount rule was met',de:'Deine Rabattregel wurde erfüllt',fr:'Ta règle de réduction est remplie'});
      add(`${status[0]} **${gameName(h.game_name,100)}**\n-# ${why} · ${status[1]} · ${relative(h.created_at)}`);
    });
    if(!entries.length) add('📭 '+t({tr:'Henüz bildirim yok.',en:'No alerts yet.',de:'Noch keine Benachrichtigungen.',fr:'Pas encore d’alertes.'}));
    divider();
    root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(prefix+'rhythm',t({tr:'Geri',en:'Back',de:'Zurück',fr:'Retour'}),'↩️'),
      button(prefix+'prev',previous,'◀️').setDisabled(disabled||view.page===0),
      button(prefix+'next',next,'▶️').setDisabled(disabled||start+5>=data.history.length),
      button(prefix+'retry',t({tr:'DM erişimini dene',en:'Test DM access',de:'DM-Zugang testen',fr:'Tester les MP'}),'✉️')));
  }else{
    const p=data.preference, zone=effectiveTimezone(data);
    const instant=t({tr:'Anında',en:'Right away',de:'Sofort',fr:'Tout de suite'});
    const quiet=t({tr:'Rahatsız etme saatleri',en:'Do not disturb',de:'Nicht stören',fr:'Ne pas déranger'});
    const digest=t({tr:'Günlük özet',en:'Daily digest',de:'Tägliche Zusammenfassung',fr:'Résumé quotidien'});
    const colon=lang==='fr'?' :':':';
    const current=p.mode==='quiet'?`🌙 ${quiet} · ${clock(p.quietStart)}–${clock(p.quietEnd)}`
      :p.mode==='digest'?`📬 ${digest} · ${clock(p.digestMinute)}`
      :`⚡ ${instant}`;
    add(panelHeader('alerts',lang,t({tr:'Sen bildirimlere değil, bildirimler sana uysun',en:'Alerts on your terms',de:'Benachrichtigungen, wie du sie willst',fr:'Des alertes à ton rythme'}),
      t({tr:'Şu an: ',en:'Now: ',de:'Aktuell: ',fr:'Actuellement : '})+'**'+current+'**\n🌍 '+t({tr:'Saat dilimi: ',en:'Time zone: ',de:'Zeitzone: ',fr:'Fuseau horaire : '})+
      (zone?timezoneLabel(zone):t({tr:'seçilmedi, aşağıdan seç',en:'not set, choose below',de:'nicht gewählt, unten auswählen',fr:'non choisi, choisis-le ci-dessous'}))));
    notice();
    divider();
    add([
      `⚡ **${instant}${colon}** `+t({
        tr:'Fırsatı bulduğum an DM atarım.',en:'a DM the moment I find a deal.',
        de:'eine DM, sobald ich ein Angebot finde.',fr:'un MP dès que je trouve un bon plan.',
      }),
      `🌙 **${quiet}${colon}** `+t({
        tr:'Bu saatlerde sessiz kalırım; saat bitince bekleyenleri gönderirim.',
        en:'I stay quiet during these hours and send what’s waiting when they end.',
        de:'In dieser Zeit bleibe ich still und schicke danach, was sich angesammelt hat.',
        fr:'je reste silencieux pendant ces heures et j’envoie ce qui attend à la fin.',
      }),
      `📬 **${digest}${colon}** `+t({
        tr:'Günde bir kez, seçtiğin saatte tek mesaj.',en:'one message a day, at the time you pick.',
        de:'eine Nachricht am Tag, zu deiner Wunschzeit.',fr:'un seul message par jour, à l’heure de ton choix.',
      }),
    ].join('\n'));
    root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(prefix+'instant',instant,'⚡',p.mode==='instant'),
      button(prefix+'quiet-night',t({tr:'Gece 23:00–08:00',en:'Night 23:00–08:00',de:'Nachts 23:00–08:00',fr:'La nuit 23:00–08:00'}),'🌙',p.mode==='quiet'),
      button(prefix+'digest-evening',t({tr:'Her akşam 19:00',en:'Every evening 19:00',de:'Jeden Abend 19:00',fr:'Chaque soir 19:00'}),'📬',p.mode==='digest')));
    root.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(prefix+'quiet',t({tr:'Kendi saatlerim',en:'My own hours',de:'Eigene Zeiten',fr:'Mes horaires'}),'🕐'),
      button(prefix+'digest',t({tr:'Kendi özet saatim',en:'My digest time',de:'Eigene Uhrzeit',fr:'Mon heure de résumé'}),'🕖'),
      button(prefix+'history',t({tr:'Bildirim geçmişi',en:'Alert history',de:'Verlauf',fr:'Historique'}),'📜')));
    root.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(prefix+'timezone').setDisabled(disabled)
        .setPlaceholder('🌍 '+t({tr:'Saat dilimini değiştir',en:'Change time zone',de:'Zeitzone ändern',fr:'Changer de fuseau horaire'}))
        .addOptions(timezoneChoices(data.config.storeCountryCode,zone).map(choice=>({
          label:timezoneLabel(choice),value:choice,default:choice===zone})))));
    const frequency=messagesFor(lang).setupWizardFrequency(data.pollIntervalHours??defaultPollIntervalHours);
    add('-# 🔄 '+t({
      tr:`Kontrol sıklığı: ${frequency}. Bekleyen bildirimlerin fiyatını göndermeden önce bir kez daha kontrol ederim.`,
      en:`Checks: ${frequency.toLowerCase()}. I double-check the price of waiting alerts before sending them.`,
      de:`Prüfung: ${frequency}. Bei wartenden Benachrichtigungen prüfe ich den Preis vor dem Senden noch einmal.`,
      fr:`Vérifications : ${frequency.toLowerCase()}. Je revérifie le prix des alertes en attente avant de les envoyer.`,
    }));
  }
  divider();
  root.addActionRowComponents(buildTabBar('assistant',session,lang,{active:games?'games':'alerts',
    activeIsRoot:view.screen==='wishlist'||view.screen==='rhythm',disabled}));
  if(disabled) for(const c of root.components) if(c instanceof ActionRowBuilder) for(const control of c.components)
    if('setDisabled' in control) control.setDisabled(true);
  add(dealioFooter(lang));
  assertComponentsV2Limit([root]);
  return root;
}

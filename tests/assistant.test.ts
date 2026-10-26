
import { describe,it,expect,vi } from 'vitest';
import { createDatabase } from '../src/persistence/database.js';
import { UserConfigRepository } from '../src/persistence/user-config-repository.js';
import { WishlistStateRepository } from '../src/persistence/wishlist-state-repository.js';
import { NotificationService, type NotificationSender } from '../src/application/notification-service.js';
import { deliveryAllowed, type NotificationPreference } from '../src/domain/notification-preference.js';
import { createSaleKey } from '../src/domain/sale.js';
import type { WishlistItem } from '../src/domain/steam.js';
import { buildAssistantView } from '../src/discord/assistant-view.js';
import { parseTargetMinor } from '../src/discord/commands/assistant.js';
import { redactSecrets } from '../src/application/safe-logger.js';

function fixture(){
 const db=createDatabase(':memory:'),users=new UserConfigRepository(db),states=new WishlistStateRepository(db);
 const config=users.upsert('u','76561198000000000','tr','TR','2026-09-12T00:00:00.000Z');
 let clock=Date.parse('2026-09-12T12:00:00Z');
 const item=(final=1000,currency='USD'):WishlistItem=>({appId:10,name:'A Game',priority:1,dateAdded:null,onSale:final<1000,
   price:{initialMinor:1000,finalMinor:final,currency,discountPercent:100-final/10,isFree:false}});
 const observe=(final:number,currency='USD',baseline=false)=>{
   const i=item(final,currency);clock+=600000;
   return states.recordObservation(config,{item:i,saleKey:i.onSale?createSaleKey(i.price!):null,observedAt:new Date(clock).toISOString()},{baseline});
 };
 const target=(amount=700)=>states.assistant.saveRule(config,10,{mode:'target',targetMinor:amount,currency:'USD',percent:null,muted:false});
 const send=vi.fn().mockResolvedValue({messageId:'123',channelId:'456',deliveredAt:'2026-09-12T13:00:00Z'});
 const sender:NotificationSender={send,plan:items=>items.map(i=>({notifications:[i]}))};
 const notification=new NotificationService(users,states,sender,{now:()=>new Date(clock)});
 // Moves past the next Steam price change (10:00 Pacific) without an observation.
 const nextDay=()=>{clock+=86400000;};
 return {db,users,states,config,item,observe,target,send,notification,nextDay,clock:()=>new Date(clock)};
}
describe('personal assistant durable rules',()=>{
 it('notifies only on target crossings, survives service recreation, and crosses again after rising',async()=>{
  const f=fixture();try{
   f.observe(1000);f.target();f.observe(800);f.observe(600);
   expect(await f.notification.deliverPending('u')).toMatchObject({sentCount:1});
   // A small further drop under the target is not a new alert.
   f.observe(560);expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   f.observe(900);f.nextDay();f.observe(600);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
   expect(f.send).toHaveBeenCalledTimes(2);
   expect(f.states.assistant.history('u',f.clock())[0]).toMatchObject({discord_message_id:'123',reason:'target:700:USD'});
  }finally{f.db.close();}
 });
 it('treats a target that is missed on one read and met again before the next price change as the same deal',async()=>{
  const f=fixture();try{
   f.observe(1000);f.target();f.observe(600);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
   // Steam answers one read with the price from before the daily change, then the deal again.
   f.observe(1000);f.observe(600);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   // A clearly lower price is still a new alert, measured from the delivered 600.
   f.observe(1000);f.observe(540);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
   expect(f.send).toHaveBeenCalledTimes(2);
  }finally{f.db.close();}
 });
 it('does not send an initial DM for an already matching price or an unknown baseline',async()=>{
  const f=fixture();try{f.observe(600);f.target();f.observe(560);expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   f.states.assistant.saveRule(f.config,20,{mode:'target',targetMinor:700,currency:'USD',percent:null,muted:false});
  }finally{f.db.close();}
 });
 it('alerts again when a met target falls clearly lower, measured from the baseline or the last alert',async()=>{
  const f=fixture();try{
   // Saved while already under the target: 600 is the baseline, 540 or less is clearly lower.
   f.observe(600);f.target();f.observe(550);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   f.observe(540);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
   // The next step is measured from the alerted 540 (486 or less).
   f.observe(490);expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   f.observe(480);expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
   expect(f.send).toHaveBeenCalledTimes(2);
  }finally{f.db.close();}
 });
 it('lets the default discount rule cover a target left in an old currency, without an alert for the switch',async()=>{
  const f=fixture();try{f.observe(1000);f.target();f.observe(600);
   // Steam now prices the game in EUR: the USD target can no longer apply.
   f.observe(500,'EUR');
   expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   // The default rule now governs the game: a clearly deeper discount alerts.
   f.observe(300,'EUR');
   expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
   expect(f.send.mock.calls[0][0].notifications[0]).toMatchObject({currency:'EUR',discountPercent:70});
  }finally{f.db.close();}
 });
 it('invalidates pending targets on a currency change',async()=>{
  const f=fixture();try{f.observe(1000);f.target();f.observe(600);f.observe(500,'EUR');
   expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   expect(f.states.assistant.history('u',f.clock())[0]?.status).toBe('expired');
  }finally{f.db.close();}
 });
 it('target replaces global discount including a regular price drop',async()=>{
  const f=fixture();try{f.users.setMinimumDiscountPercent('u',90,new Date().toISOString());f.observe(1000);f.target(950);f.observe(900);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
  }finally{f.db.close();}
 });
 it('mute and rule revision invalidate pending offers',async()=>{
  const f=fixture();try{f.observe(1000);f.target();f.observe(600);
   const rule=f.states.assistant.rule(f.config,10)!;
   f.states.assistant.saveRule(f.config,10,{...rule,muted:true});f.observe(500);
   expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   expect(f.states.assistant.rule(f.config,10)?.revision).toBe(2);
  }finally{f.db.close();}
 });
 it('deleted users lose personal rules, schedules, snapshots and queued deliveries',async()=>{
  const f=fixture();try{f.observe(1000);f.target();f.observe(600);f.states.assistant.saveSnapshot(f.config,{items:[f.item()],errors:[]},f.clock().toISOString());
   f.states.assistant.savePreference('u',{mode:'instant',timezone:null,quietStart:null,quietEnd:null,digestMinute:null});
   f.users.deleteByDiscordUserId('u');expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   for(const table of ['game_rule','notification_preference','wishlist_snapshot','notification_log'])
    expect(f.db.prepare('SELECT COUNT(*) n FROM '+table).get()?.n).toBe(0);
  }finally{f.db.close();}
 });
 it('queues quiet-hour candidates durably and prevents stale delivery when verification fails',async()=>{
  const f=fixture();try{f.observe(1000);f.target();f.observe(600);
   f.states.assistant.savePreference('u',{mode:'quiet',timezone:'UTC',quietStart:0,quietEnd:1439,digestMinute:null});
   expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   expect(f.db.prepare("SELECT status FROM notification_log").get()?.status).toBe('candidate');
   f.states.assistant.savePreference('u',{mode:'instant',timezone:null,quietStart:null,quietEnd:null,digestMinute:null});
   const n=new NotificationService(f.users,f.states,{send:f.send,plan:items=>items.map(i=>({notifications:[i]}))},{revalidate:async()=>false});
   expect((await n.deliverPending('u')).sentCount).toBe(0);expect(f.send).not.toHaveBeenCalled();
  }finally{f.db.close();}
 });
 it('records changes without fabricating samples from shared cached prices',()=>{
  const f=fixture();try{f.observe(1000);f.observe(1000);f.observe(800);f.observe(800);
   expect(f.states.assistant.prices(10,'TR','USD',f.clock())).toHaveLength(2);
  }finally{f.db.close();}
 });
 it('retention keeps active offer dedup and active queue',async()=>{
  const f=fixture();try{f.observe(1000);f.target();f.observe(600);await f.notification.deliverPending('u');
   f.states.assistant.cleanup(new Date('2027-01-01T00:00:00Z'));
   expect(f.db.prepare("SELECT COUNT(*) n FROM notification_log").get()?.n).toBe(1);
   expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
   expect(f.states.assistant.prices(10,'TR','USD',new Date('2027-01-01'))).toEqual([]);
  }finally{f.db.close();}
 });
 it.each(['tr','en'] as const)('renders all personal screens within Discord limits in %s',language=>{
  const f=fixture();try{
   const items=[10,20,30].map(appId=>({...f.item(600),appId,name:'A long game title '.repeat(8)}));
   for(const screen of ['wishlist','detail','history','rhythm'] as const){
    const panel=buildAssistantView({config:{...f.config,language},items,capturedAt:f.clock().toISOString(),rules:new Map(),
     preference:{mode:'instant',timezone:null,quietStart:null,quietEnd:null,digestMinute:null},history:[]},
     {screen,page:0,query:'',eligibleOnly:false,selectedAppId:10},'123');
    expect(panel.toJSON().type).toBe(17);
   }
  }finally{f.db.close();}
 });
});

describe('game detail price history',()=>{
 const render=(priceHistory:Parameters<typeof buildAssistantView>[0]['priceHistory'],language:'tr'|'en'='tr')=>{
  const f=fixture();try{
   return JSON.stringify(buildAssistantView({config:{...f.config,language},items:[f.item(115)],capturedAt:f.clock().toISOString(),rules:new Map(),
    preference:{mode:'instant',timezone:null,quietStart:null,quietEnd:null,digestMinute:null},history:[],
    ...(priceHistory?{priceHistory}:{})},{screen:'detail',page:0,query:'',eligibleOnly:false,selectedAppId:10},'123').toJSON()).replace(/ /g,' ');
  }finally{f.db.close();}
 };
 const history={low:{currency:'USD',amountMinor:57,discountPercent:90,recordedAt:'2024-11-21T18:00:00.000Z',since:'2024-02-11T00:59:31.000Z'},
  recent:[{currency:'USD',amountMinor:115,discountPercent:80,recordedAt:'2026-10-01T18:26:44.000Z'},
   {currency:'USD',amountMinor:579,discountPercent:0,recordedAt:'2026-07-09T17:17:12.000Z'}]};

 it('replaces Dealio observations with Steam price history from IsThereAnyDeal',()=>{
  const text=render({status:'ready',history});
  expect(text).toContain('Steam fiyat geçmişi');
  expect(text).toContain('Şubat 2024 sonrası en düşük: **$0,57** (%90 indirim · Kasım 2024)');
  expect(text).toContain(`<t:${Date.parse('2026-10-01T18:26:44.000Z')/1000}:d> · **$1,15** · %80`);
  expect(text).toContain(`<t:${Date.parse('2026-07-09T17:17:12.000Z')/1000}:d> · **$5,79**"`);
  expect(text).toContain('[IsThereAnyDeal](https://isthereanydeal.com/)');
  expect(text).not.toMatch(/gözlem|observation/i);
 });

 it.each([
  [{status:'loading'} as const,'Fiyat geçmişini getiriyorum…'],
  [{status:'ready',history:null} as const,'Fiyat geçmişini şu an alamadım.'],
  [{status:'ready',history:{low:null,recent:[]}} as const,'Bu bölge için henüz Steam fiyat geçmişi yok.'],
 ])('explains a %j price history state',(state,expected)=>{
  expect(render(state)).toContain(expected);
 });

 it('omits the section when price history is not configured',()=>{
  const text=render(undefined,'en');
  expect(text).not.toContain('Steam price history');
  expect(text).not.toMatch(/observation/i);
 });
});

describe('delivery and rule acceptance',()=>{
 it('delivers a target reached by a base-price change without inventing a discount',async()=>{
  const f=fixture();try{
   f.observe(1000);f.target();
   const item={...f.item(600),onSale:false,price:{...f.item(600).price!,initialMinor:600,discountPercent:0}};
   const candidate=f.states.recordObservation(f.config,{item,saleKey:null,observedAt:f.clock().toISOString()}).notificationCandidate;
   expect(candidate?.reason).toBe('target:700:USD');
   expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
  }finally{f.db.close();}
 });
 it('holds a sale found after an empty digest time until the next day',async()=>{
  const f=fixture();try{
   f.observe(1000);f.target();f.states.assistant.savePreference('u',{mode:'digest',timezone:'UTC',quietStart:null,quietEnd:null,digestMinute:0});
   expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   expect(f.states.assistant.preference('u').lastDigestDate).toBe('2026-09-12');
   f.observe(600);expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   expect(f.send).not.toHaveBeenCalled();
   const sender:NotificationSender={send:f.send,plan:items=>items.map(i=>({notifications:[i]}))};
   const nextDay=new NotificationService(f.users,f.states,sender,{now:()=>new Date('2026-09-13T00:05:00Z')});
   expect((await nextDay.deliverPending('u')).sentCount).toBe(1);
  }finally{f.db.close();}
 });
 it('keeps a second same-day crossing queued across restarts until the next digest',async()=>{
  const f=fixture();try{
   f.observe(1000);f.target();f.states.assistant.savePreference('u',{mode:'digest',timezone:'UTC',quietStart:null,quietEnd:null,digestMinute:0});
   f.observe(600);expect((await f.notification.deliverPending('u')).sentCount).toBe(1);
   f.observe(900);f.observe(500);expect((await f.notification.deliverPending('u')).sentCount).toBe(0);
   const sender:NotificationSender={send:f.send,plan:items=>items.map(i=>({notifications:[i]}))};
   const resumed=new NotificationService(f.users,f.states,sender,{now:()=>new Date('2026-09-13T18:00:00Z')});
   expect((await resumed.deliverPending('u')).sentCount).toBe(1);
   expect(f.states.assistant.preference('u').lastDigestDate).toBe('2026-09-13');
   expect(f.send.mock.calls.at(-1)?.[2]).toEqual({digest:true});
  }finally{f.db.close();}
 });
 it('expires a delayed target when fresh validation finds a higher price',async()=>{
  const f=fixture();try{
   f.observe(1000);f.target();f.observe(600);
   const n=new NotificationService(f.users,f.states,{send:f.send,plan:items=>items.map(i=>({notifications:[i]}))},
     {revalidate:async()=>{f.observe(900);return true;}});
   expect((await n.deliverPending('u')).sentCount).toBe(0);
   expect(f.states.assistant.history('u',f.clock())[0].status).toBe('expired');
  }finally{f.db.close();}
 });
 it('distinguishes a Discord privacy block from an unrelated delivery failure',async()=>{
  const f=fixture();try{
   f.observe(1000);f.target();f.observe(600);f.send.mockRejectedValueOnce(Object.assign(new Error('DM denied'),{code:50007,status:403}));
   await f.notification.deliverPending('u');
   expect(f.states.assistant.history('u',f.clock())[0].status).toBe('blocked');
  }finally{f.db.close();}
 });
});
describe('local-time scheduling',()=>{
 const quiet:NotificationPreference={mode:'quiet',timezone:'Europe/Istanbul',quietStart:1380,quietEnd:480,digestMinute:null};
 it('handles midnight across the selected timezone',()=>{
  expect(deliveryAllowed(quiet,new Date('2026-09-12T20:00:00Z'))).toBe(false);
  expect(deliveryAllowed(quiet,new Date('2026-09-13T04:59:00Z'))).toBe(false);
  expect(deliveryAllowed(quiet,new Date('2026-09-13T05:00:00Z'))).toBe(true);
 });
 it('requires an explicit timezone',()=>expect(()=>deliveryAllowed({...quiet,timezone:null},new Date())).toThrow('timezone'));
 it('rejects unsupported zones and equal quiet endpoints',()=>{
  expect(()=>deliveryAllowed({...quiet,timezone:'Invalid/Zone'},new Date())).toThrow();
  expect(()=>deliveryAllowed({...quiet,quietEnd:1380},new Date())).toThrow();
 });
 it('handles spring DST gap and autumn repeated hour once per local date',()=>{
  const digest:NotificationPreference={mode:'digest',timezone:'America/New_York',quietStart:null,quietEnd:null,digestMinute:150};
  expect(deliveryAllowed(digest,new Date('2026-03-08T07:00:00Z'))).toBe(true);
  const fold={...digest,digestMinute:90,lastDigestDate:'2026-11-01'};
  expect(deliveryAllowed(fold,new Date('2026-11-01T06:30:00Z'))).toBe(false);
 });
});
describe('input and logging security',()=>{
 it.each([['19.99',1999],['19,9',1990],['0',0],['-1',null],['1e3',null],['1.999',null],['NaN',null]])('parses target %s', (raw,expected)=>expect(parseTargetMinor(String(raw))).toBe(expected));
 it('redacts nested Discord interaction and webhook credentials and authorization',()=>{
  const output=redactSecrets({error:new Error('https://discord.com/api/v10/webhooks/123/SUPERSECRET?wait=true'),
   url:'https://discord.com/api/v10/interactions/123/OTHERTOKEN/callback',authorization:'Bot PRIVATEVALUE',token:'TOKENTEXT'});
  for(const secret of ['SUPERSECRET','OTHERTOKEN','PRIVATEVALUE','TOKENTEXT'])expect(output).not.toContain(secret);
 });
});

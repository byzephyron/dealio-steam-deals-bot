import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { dealioBrand } from '../../src/discord/ui/brand.js';
import { assertComponentsV2Limit } from '../../src/discord/ui/components-v2.js';
import { buildSupportPanel, supportHelpUrl } from '../../src/discord/support/support-view.js';

/**
 * The Dealio support server as data: roles, channels, permissions and the messages
 * Dealio keeps in its info channels. `setup-support-server.ts` applies it; running it
 * again updates what it created instead of adding duplicates (everything is found by name).
 */

const P = PermissionFlagsBits;
const bits = (...flags: bigint[]): string => flags.reduce((all, flag) => all | flag, 0n).toString();

export const publicSiteUrl = 'https://byzephyron.github.io/dealio-public-pages';
export const links = {
  website: `${publicSiteUrl}/index-en.html`,
  help: supportHelpUrl,
  privacy: `${publicSiteUrl}/privacy.html`,
  terms: `${publicSiteUrl}/terms.html`,
  github: 'https://github.com/byzephyron/dealio-steam-deals-bot',
  discordGuidelines: 'https://discord.com/guidelines',
  discordTerms: 'https://discord.com/terms',
  invite: (clientId: string) => `https://discord.com/oauth2/authorize?client_id=${clientId}`,
} as const;

export const guildSettings = {
  name: 'Dealio Support',
  description: 'Help, updates and deal talk for Dealio, the Discord bot that watches your Steam wishlist and DMs you when your games hit your price.',
  preferred_locale: 'en-US',
  // Members need a verified email and a five-minute-old account to talk.
  verification_level: 2,
  // Scan media from every member.
  explicit_content_filter: 2,
  // Only @mentions notify, so a busy server never buzzes everyone's phone.
  default_message_notifications: 1,
  // Hide join messages, join-sticker prompts and setup tips; keep boost messages.
  system_channel_flags: (1 << 0) | (1 << 2) | (1 << 3),
} as const;

/** What every member may do server-wide; channels narrow it down. No thread creation, no @everyone. */
export const everyonePermissions = bits(
  P.ViewChannel, P.CreateInstantInvite, P.ChangeNickname, P.SendMessages, P.SendMessagesInThreads,
  P.EmbedLinks, P.AttachFiles, P.AddReactions, P.UseExternalEmojis, P.UseExternalStickers,
  P.ReadMessageHistory, P.UseApplicationCommands, P.Connect, P.Speak, P.Stream, P.UseVAD,
  // Voice activities, soundboard, voice messages, polls and user-installed apps.
  P.UseEmbeddedActivities, P.UseSoundboard, P.UseExternalSounds, P.SendVoiceMessages, P.SendPolls, P.UseExternalApps,
);

export type StaffRoleKey = 'owner' | 'admins' | 'moderators' | 'support';
export type SupporterRoleKey = 'legend' | 'superDonator' | 'donator';
export type RoleKey = 'dealioBot' | StaffRoleKey | 'bots' | SupporterRoleKey | 'booster' | 'updates';

export interface RoleSpec {
  readonly key: RoleKey;
  readonly name: string;
  /** Earlier names, so renaming a role keeps its ID (the ticket role ID is in the VM's .env). */
  readonly aliases?: readonly string[];
  readonly color: number;
  /** A gradient, shown once the server unlocks enhanced role colors (boost level 2). */
  readonly gradient?: readonly [number, number];
  /** A role icon, shown once the server unlocks role icons (boost level 2). */
  readonly icon: string;
  readonly permissions: string;
  /** Discord's own Server Booster role: it exists after the first boost and Discord assigns it. */
  readonly managedBooster?: true;
  /** Shown as its own group in the member list; ping-only roles are not. */
  readonly hoist?: boolean;
}

const moderation = [P.ManageMessages, P.ManageThreads, P.ModerateMembers, P.ManageNicknames, P.ViewAuditLog, P.PinMessages];

/**
 * Top to bottom. The owner and the staff rank above Dealio; Discord's own Dealio role sits
 * right under Support Team (the owner drags it there once: a bot cannot lower its own role),
 * and everything from 🤖 Dealio down is ordered by the script. Members, boosters and donators
 * stay below every bot.
 */
export const staffAboveDealio: readonly RoleKey[] = ['owner', 'admins', 'moderators', 'support'];

export const roles: readonly RoleSpec[] = [
  { key: 'owner', name: '👑 Owner', icon: '👑', color: 0xf1c40f, gradient: [0xf1c40f, 0xff8c00], permissions: bits(P.Administrator) },
  { key: 'admins', name: '🛡️ Admins', aliases: ['Dealio Team'], icon: '🛡️', color: 0xe74c3c, gradient: [0xe74c3c, 0xff6b81],
    permissions: bits(P.Administrator) },
  { key: 'moderators', name: '🔨 Moderators', icon: '🔨', color: 0x3498db, gradient: [0x3498db, 0x66c0f4],
    permissions: bits(...moderation, P.KickMembers, P.BanMembers, P.MuteMembers, P.MoveMembers, P.ManageEvents) },
  { key: 'support', name: '🎧 Support Team', aliases: ['Support Team'], icon: '🎧', color: dealioBrand.colors.accent,
    gradient: [dealioBrand.colors.accent, dealioBrand.colors.primary], permissions: bits(...moderation) },
  // Dealio's own, separate from the role Discord manages for it: every permission, below the staff.
  { key: 'dealioBot', name: '🤖 Dealio', icon: '🤖', color: dealioBrand.colors.primary,
    gradient: [dealioBrand.colors.primary, dealioBrand.colors.accent], permissions: bits(P.Administrator) },
  // Every other bot gets this one; their own managed roles are placed right below it.
  { key: 'bots', name: '⚙️ Bots', icon: '⚙️', color: 0x99aab5, permissions: '0' },
  { key: 'booster', name: '💎 Server Booster', icon: '💎', color: 0xf47fff, gradient: [0xf47fff, 0xb57edc], permissions: '0', managedBooster: true },
  { key: 'legend', name: '🌟 Legendary Donator', icon: '🌟', color: 0xffd166, gradient: [0xffd166, 0xff7eb3], permissions: '0' },
  { key: 'superDonator', name: '💖 Super Donator', icon: '💖', color: 0xff7eb3, gradient: [0xff7eb3, 0xc77dff], permissions: '0' },
  { key: 'donator', name: '☕ Donator', icon: '☕', color: 0xd4a373, gradient: [0xd4a373, 0xf4d6a0], permissions: '0' },
  // Members pick it in onboarding; announcements mention it instead of @everyone.
  { key: 'updates', name: '🔔 Updates', icon: '🔔', color: 0, permissions: '0', hoist: false },
];

/** The roles the guild owner gets: the crown, and the ticket pings. */
export const ownerRoles: readonly RoleKey[] = ['owner', 'support'];

/** The roles Dealio itself wears. */
export const dealioRoles: readonly RoleKey[] = ['dealioBot'];

export const buyMeACoffeeUrl = 'https://buymeacoffee.com/dealio';

/** Who a channel rule is for: everyone, one of the roles above, or Dealio itself. */
export type Audience = 'everyone' | RoleKey | 'bot';
export interface OverwriteSpec { readonly audience: Audience; readonly allow?: string; readonly deny?: string }

export type ChannelKey =
  | 'welcome' | 'rules' | 'announcements' | 'faq' | 'supportDealio'
  | 'general' | 'offTopic' | 'nowPlaying' | 'deals' | 'dealWins' | 'suggestions' | 'giveaways' | 'tryDealio' | 'lounge'
  | 'turkish' | 'german' | 'french'
  | 'owo' | 'dankMemer' | 'karuta' | 'lfg' | 'musicCommands' | 'bump'
  | 'voiceLounge' | 'voiceGaming1' | 'voiceGaming2' | 'voiceMusic' | 'stage' | 'afk'
  | 'tickets'
  | 'ticketLog' | 'modLog' | 'staffChat' | 'adminChat' | 'discordUpdates' | 'staffVoice';

export interface ChannelSpec {
  readonly key: ChannelKey;
  readonly name: string;
  readonly type: ChannelType.GuildText | ChannelType.GuildAnnouncement | ChannelType.GuildForum
    | ChannelType.GuildVoice | ChannelType.GuildStageVoice;
  /** Text-like channels only; voice channels have none. */
  readonly topic?: string;
  readonly userLimit?: number;
  readonly bitrate?: number;
  readonly overwrites: readonly OverwriteSpec[];
  readonly rateLimitPerUser?: number;
  /** Forum tags; `moderated` ones only the team can apply. */
  readonly tags?: readonly { readonly name: string; readonly emoji: string; readonly moderated?: boolean }[];
  readonly defaultReaction?: string;
  /** A forum that opens as a grid of image cards (media channels cannot be created over the API). */
  readonly gallery?: true;
}

export interface CategorySpec {
  readonly name: string;
  readonly overwrites: readonly OverwriteSpec[];
  readonly channels: readonly ChannelSpec[];
}

const staff: readonly RoleKey[] = ['admins', 'moderators', 'support'];
const supporters: readonly RoleKey[] = ['booster', 'legend', 'superDonator', 'donator'];
const botPosting = bits(P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory);
const threadCreation = [P.CreatePublicThreads, P.CreatePrivateThreads];

/** Everyone reads; only the team and Dealio post. */
const readOnly: readonly OverwriteSpec[] = [
  { audience: 'everyone', allow: bits(P.ViewChannel, P.ReadMessageHistory), deny: bits(P.SendMessages, P.SendMessagesInThreads, ...threadCreation) },
  ...staff.map((audience): OverwriteSpec => ({ audience, allow: bits(P.SendMessages) })),
  { audience: 'bot', allow: bits(P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory) },
];

/** Hidden from members. */
const staffOnly: readonly OverwriteSpec[] = [
  { audience: 'everyone', deny: bits(P.ViewChannel) },
  ...staff.map((audience): OverwriteSpec => ({ audience, allow: bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory) })),
  { audience: 'bot', allow: botPosting },
];

/** Only Administrator holders (Owner, Admins, Dealio) see it: no overwrite grants access. */
const adminsOnly: readonly OverwriteSpec[] = [{ audience: 'everyone', deny: bits(P.ViewChannel) }];

/** Members react; bots and the team post (giveaways). */
const reactOnly: readonly OverwriteSpec[] = [
  { audience: 'everyone', allow: bits(P.ViewChannel, P.ReadMessageHistory, P.AddReactions),
    deny: bits(P.SendMessages, P.SendMessagesInThreads, ...threadCreation) },
  ...staff.map((audience): OverwriteSpec => ({ audience, allow: bits(P.SendMessages) })),
  { audience: 'bots', allow: bits(P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AddReactions, P.ReadMessageHistory) },
];

/** Supporters (boosters and donators) and the team. */
const supportersOnly: readonly OverwriteSpec[] = [
  { audience: 'everyone', deny: bits(P.ViewChannel) },
  ...[...supporters, ...staff].map((audience): OverwriteSpec => ({ audience, allow: bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory) })),
  { audience: 'bot', allow: botPosting },
];

export const categories: readonly CategorySpec[] = [
  {
    name: '📌 Start Here',
    overwrites: readOnly,
    channels: [
      { key: 'welcome', name: '👋・welcome', type: ChannelType.GuildText, topic: 'What Dealio is and where to find everything.', overwrites: readOnly },
      { key: 'rules', name: '📜・rules', type: ChannelType.GuildText, topic: 'The server rules. Being here means you agree to them.', overwrites: readOnly },
      { key: 'announcements', name: '📣・announcements', type: ChannelType.GuildAnnouncement, topic: 'Releases, new features and service status. Follow it to get updates in your own server.', overwrites: readOnly },
      { key: 'faq', name: '❓・faq', type: ChannelType.GuildText, topic: 'Quick answers to the most common questions.', overwrites: readOnly },
      { key: 'supportDealio', name: '💝・support-dealio', type: ChannelType.GuildText, topic: 'Keep Dealio free: Donator and Booster roles and their perks.', overwrites: readOnly },
    ],
  },
  {
    name: '💬 Community',
    overwrites: [],
    channels: [
      { key: 'general', name: '💬・general', type: ChannelType.GuildText, topic: 'Chat about Dealio, Steam and games. For account problems, open a ticket instead.', overwrites: [] },
      { key: 'offTopic', name: '🎮・off-topic', type: ChannelType.GuildText, topic: 'Games, memes and everything that isn’t Dealio. Keep it friendly.', overwrites: [] },
      { key: 'nowPlaying', name: '🕹️・now-playing', type: ChannelType.GuildText, topic: 'What are you playing right now? Share it, and find your next game.', overwrites: [] },
      {
        key: 'deals', name: '🔥・deals', type: ChannelType.GuildText, rateLimitPerUser: 30, overwrites: [],
        topic: 'Share great Steam deals you caught. Store links only: no referral, key-reseller or affiliate links.',
      },
      {
        key: 'dealWins', name: '🏆・deal-wins', type: ChannelType.GuildForum, gallery: true, rateLimitPerUser: 300, defaultReaction: '🔥', overwrites: [],
        topic: 'Show off what you bought thanks to a Dealio alert: a screenshot of the alert or your library, and what you saved.',
        tags: [
          { name: 'Huge saving', emoji: '💸' },
          { name: 'Free game', emoji: '🎁' },
          { name: 'Wishlist win', emoji: '❤️' },
        ],
      },
      {
        key: 'suggestions', name: '💡・suggestions', type: ChannelType.GuildForum, rateLimitPerUser: 600, defaultReaction: '👍',
        overwrites: [{ audience: 'bot', allow: bits(P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.ReadMessageHistory) }],
        topic: 'One idea per post. Search first and 👍 existing ideas instead of reposting. Tell us the problem the idea solves; the team tags each post with its status.',
        tags: [
          { name: 'Feature', emoji: '✨' },
          { name: 'Improvement', emoji: '🛠️' },
          { name: 'Under review', emoji: '👀', moderated: true },
          { name: 'Planned', emoji: '🗓️', moderated: true },
          { name: 'Done', emoji: '✅', moderated: true },
          { name: 'Declined', emoji: '❌', moderated: true },
        ],
      },
      {
        key: 'giveaways', name: '🎉・giveaways', type: ChannelType.GuildText, overwrites: reactOnly,
        topic: 'Steam game giveaways from the team. React with 🎉 to enter; the bot picks the winners.',
      },
      {
        key: 'tryDealio', name: '🤖・try-dealio', type: ChannelType.GuildText, overwrites: [],
        topic: 'Try /dealio here. Your panel is private: only you see it, and it doesn’t clutter the chat.',
      },
      {
        key: 'lounge', name: '💖・supporters-lounge', type: ChannelType.GuildText, overwrites: supportersOnly,
        topic: 'A cosy corner for Donators and Server Boosters. Thank you for keeping Dealio free!',
      },
    ],
  },
  {
    name: '🌍 International',
    overwrites: [],
    channels: [
      { key: 'turkish', name: '🇹🇷・türkçe', type: ChannelType.GuildText, overwrites: [],
        topic: 'Türkçe sohbet. Dealio, Steam ve oyunlar hakkında konuş; hesap sorunları için ticket aç.' },
      { key: 'german', name: '🇩🇪・deutsch', type: ChannelType.GuildText, overwrites: [],
        topic: 'Deutscher Chat über Dealio, Steam und Spiele. Für Kontoprobleme öffne ein Ticket.' },
      { key: 'french', name: '🇫🇷・français', type: ChannelType.GuildText, overwrites: [],
        topic: 'Discussion en français sur Dealio, Steam et les jeux. Pour un souci de compte, ouvre un ticket.' },
    ],
  },
  {
    name: '🎮 Games & Bots',
    overwrites: [],
    channels: [
      { key: 'owo', name: '🎲・owo', type: ChannelType.GuildText, overwrites: [], topic: 'OwO hunting, battles and gambling: `owo help`. OwO only answers here.' },
      { key: 'dankMemer', name: '🐸・dank-memer', type: ChannelType.GuildText, overwrites: [], topic: 'Dank Memer economy and games: `/help`. Dank Memer only answers here.' },
      { key: 'karuta', name: '🃏・karuta', type: ChannelType.GuildText, overwrites: [], topic: 'Karuta card drops and trades: `kd` to drop. Karuta only answers here.' },
      { key: 'lfg', name: '🔎・looking-for-group', type: ChannelType.GuildText, rateLimitPerUser: 60, overwrites: [],
        topic: 'Find people to play with: game, platform, region and when. Then hop into a 🎮 Gaming voice channel.' },
      { key: 'musicCommands', name: '🎵・music-commands', type: ChannelType.GuildText, overwrites: [],
        topic: 'Music bot commands go here (Jockie Music: `m!help`). Join 🎵 Music to listen.' },
      { key: 'bump', name: '🚀・bump', type: ChannelType.GuildText, overwrites: [],
        topic: 'Run /bump every two hours so more people find Dealio Support on DISBOARD.' },
    ],
  },
  {
    name: '🔊 Voice',
    overwrites: [],
    channels: [
      { key: 'voiceLounge', name: '🛋️ Lounge', type: ChannelType.GuildVoice, bitrate: 96_000, overwrites: [] },
      { key: 'voiceGaming1', name: '🎮 Gaming 1', type: ChannelType.GuildVoice, userLimit: 5, bitrate: 96_000, overwrites: [] },
      { key: 'voiceGaming2', name: '🎮 Gaming 2', type: ChannelType.GuildVoice, userLimit: 5, bitrate: 96_000, overwrites: [] },
      { key: 'voiceMusic', name: '🎵 Music', type: ChannelType.GuildVoice, bitrate: 96_000, overwrites: [] },
      // Stage: the team speaks, members listen and raise their hand (Q&As, launch events).
      { key: 'stage', name: '🎙️ Events', type: ChannelType.GuildStageVoice, overwrites: [
        ...staff.map((audience): OverwriteSpec => ({ audience, allow: bits(P.MuteMembers, P.MoveMembers, P.RequestToSpeak) })),
      ] },
      { key: 'afk', name: '😴 AFK', type: ChannelType.GuildVoice, overwrites: [{ audience: 'everyone', deny: bits(P.Speak, P.Stream) }] },
    ],
  },
  {
    name: '🎫 Support',
    overwrites: [],
    channels: [
      {
        key: 'tickets', name: '🎫・open-a-ticket', type: ChannelType.GuildText,
        topic: 'Press "Open a ticket" for private help from the Dealio team.',
        overwrites: [
          // Members only use the button, but they must be able to write in their own private thread.
          { audience: 'everyone', allow: bits(P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads, P.AttachFiles, P.EmbedLinks),
            deny: bits(P.SendMessages, P.AddReactions, ...threadCreation) },
          // Members with Manage Threads see every private thread in the channel.
          ...staff.map((audience): OverwriteSpec => ({ audience, allow: bits(P.ViewChannel, P.SendMessagesInThreads, P.ManageThreads) })),
          { audience: 'bot', allow: bits(P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.CreatePrivateThreads,
            P.ManageThreads, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory) },
        ],
      },
    ],
  },
  {
    name: '🔒 Staff',
    overwrites: staffOnly,
    channels: [
      {
        key: 'ticketLog', name: '📋・ticket-log', type: ChannelType.GuildText, topic: 'Dealio posts every opened and closed ticket here.',
        // Dealio pings the Support Team role here without making it mentionable by everyone.
        overwrites: [...staffOnly.filter((overwrite) => overwrite.audience !== 'bot'),
          { audience: 'bot', allow: bits(P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.MentionEveryone) }],
      },
      {
        key: 'modLog', name: '📝・mod-log', type: ChannelType.GuildText, topic: 'Moderation and member logs from Carl-bot and ProBot.',
        overwrites: [...staffOnly, { audience: 'bots', allow: bits(P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory) }],
      },
      { key: 'staffChat', name: '🛡️・staff-chat', type: ChannelType.GuildText, topic: 'Team talk. AutoMod alerts land here too.', overwrites: staffOnly },
      { key: 'adminChat', name: '🔐・admin-chat', type: ChannelType.GuildText, topic: 'Owner and Admins only.', overwrites: adminsOnly },
      { key: 'discordUpdates', name: '🔔・discord-updates', type: ChannelType.GuildText, topic: 'Discord sends Community server notices here.', overwrites: staffOnly },
      { key: 'staffVoice', name: '🔒 Staff Voice', type: ChannelType.GuildVoice, overwrites: [
        { audience: 'everyone', deny: bits(P.ViewChannel, P.Connect) },
        ...staff.map((audience): OverwriteSpec => ({ audience, allow: bits(P.ViewChannel, P.Connect, P.Speak, P.Stream) })),
      ] },
    ],
  },
];

/** Discord's own starter channels in a new server; they are replaced by the layout above. */
export const starterChannels = [
  // Channels first: a category is removed only once it is empty.
  { name: 'general', type: ChannelType.GuildText },
  { name: 'General', type: ChannelType.GuildVoice },
  { name: 'Text Channels', type: ChannelType.GuildCategory },
  { name: 'Voice Channels', type: ChannelType.GuildCategory },
] as const;

export const welcomeScreen = (channel: (key: ChannelKey) => string) => ({
  enabled: true,
  description: 'Help, updates and deal talk for Dealio, your Steam wishlist deal assistant.',
  welcome_channels: [
    { channel_id: channel('rules'), description: 'Read the rules first', emoji_name: '📜' },
    { channel_id: channel('faq'), description: 'Quick answers', emoji_name: '❓' },
    { channel_id: channel('tickets'), description: 'Private help from the team', emoji_name: '🎫' },
    { channel_id: channel('announcements'), description: 'Releases and status', emoji_name: '📣' },
    { channel_id: channel('deals'), description: 'Share Steam deals you caught', emoji_name: '🔥' },
  ],
});

/** AutoMod: block spam, mention raids, slurs and server invites; alert the team in staff chat. */
export const autoModerationRules = (ids: { readonly staffChat: string; readonly staffRoles: readonly string[] }) => {
  const alert = { type: 2, metadata: { channel_id: ids.staffChat } };
  return [
    { name: 'Dealio · Spam', event_type: 1, trigger_type: 3, actions: [{ type: 1 }, alert] },
    {
      name: 'Dealio · Mention spam', event_type: 1, trigger_type: 5,
      trigger_metadata: { mention_total_limit: 5, mention_raid_protection_enabled: true },
      actions: [{ type: 1 }, { type: 3, metadata: { duration_seconds: 600 } }, alert],
      exempt_roles: ids.staffRoles,
    },
    {
      name: 'Dealio · Harmful words', event_type: 1, trigger_type: 4,
      // Sexual content and slurs. Gaming talk keeps its everyday swearing.
      trigger_metadata: { presets: [2, 3] },
      actions: [{ type: 1 }, alert],
    },
    {
      name: 'Dealio · Invite links', event_type: 1, trigger_type: 1,
      trigger_metadata: { regex_patterns: ['(?:discord\\.gg|discord(?:app)?\\.com/invite)/\\S+'] },
      actions: [{ type: 1, metadata: { custom_message: 'Server invites aren’t allowed here. Questions? Open a ticket.' } }, alert],
      exempt_roles: ids.staffRoles,
    },
  ];
};

/**
 * Discord's member-profile AutoMod: names that pose as staff can't interact until changed.
 * Discord allows one such rule per server.
 */
export const impersonationKeywords = [
  '*dealio support*', '*dealio team*', '*dealio staff*', '*dealio admin*', '*dealio mod*',
  '*discord staff*', '*discord support*', '*steam support*', '*valve support*',
];

/**
 * Onboarding: the channels every newcomer sees, a question that tailors the rest, and
 * an opt-in for the Updates ping role. Discord needs at least seven default channels,
 * five of them open for @everyone to post.
 */
export const onboardingDefaultChannels: readonly ChannelKey[] = [
  'welcome', 'rules', 'announcements', 'faq', 'supportDealio',
  'general', 'offTopic', 'nowPlaying', 'deals', 'dealWins', 'suggestions', 'tryDealio', 'tickets',
];

export interface OnboardingPromptSpec {
  readonly title: string;
  readonly singleSelect: boolean;
  readonly options: readonly {
    readonly title: string;
    readonly description: string;
    readonly emoji: string;
    readonly channels?: readonly ChannelKey[];
    readonly roles?: readonly RoleKey[];
  }[];
}

export const onboardingPrompts: readonly OnboardingPromptSpec[] = [
  {
    title: 'What brings you to Dealio?',
    singleSelect: false,
    options: [
      { title: 'I’m new to Dealio', description: 'Show me how to get started', emoji: '🆕', channels: ['faq', 'tryDealio'] },
      { title: 'I need help', description: 'Private help from the team', emoji: '🛠️', channels: ['tickets', 'faq'] },
      { title: 'Steam deals', description: 'Share deals and show what I saved', emoji: '🔥', channels: ['deals', 'dealWins'] },
      { title: 'Ideas for Dealio', description: 'Suggest and vote on features', emoji: '💡', channels: ['suggestions'] },
    ],
  },
  {
    title: 'Which languages do you chat in?',
    singleSelect: false,
    options: [
      { title: 'English', description: 'The main chat', emoji: '🇬🇧', channels: ['general'] },
      { title: 'Türkçe', description: 'Türkçe sohbet', emoji: '🇹🇷', channels: ['turkish'] },
      { title: 'Deutsch', description: 'Deutscher Chat', emoji: '🇩🇪', channels: ['german'] },
      { title: 'Français', description: 'Discussion en français', emoji: '🇫🇷', channels: ['french'] },
    ],
  },
  {
    title: 'Into games and bots?',
    singleSelect: false,
    options: [
      { title: 'OwO', description: 'Hunt, battle and collect', emoji: '🎲', channels: ['owo'] },
      { title: 'Dank Memer', description: 'Economy, memes and games', emoji: '🐸', channels: ['dankMemer'] },
      { title: 'Karuta', description: 'Card drops and trades', emoji: '🃏', channels: ['karuta'] },
      { title: 'Find teammates', description: 'Looking-for-group and voice', emoji: '🔎', channels: ['lfg'] },
      { title: 'Music', description: 'Music bot and voice', emoji: '🎵', channels: ['musicCommands'] },
    ],
  },
  {
    title: 'Want a ping when Dealio gets an update?',
    singleSelect: true,
    options: [
      { title: 'Yes, ping me', description: 'Releases and important status news', emoji: '🔔', roles: ['updates'], channels: ['announcements'] },
      { title: 'No thanks', description: 'I’ll check announcements myself', emoji: '🔕', channels: ['announcements'] },
    ],
  },
];

// ---------------------------------------------------------------------------------
// Other bots. Only a person can add a bot (Discord asks them to authorize it), so the
// owner adds them from the invite panel in staff chat; running this script afterwards
// gives each the ⚙️ Bots role and keeps game bots in their own channels.

const textBot = [P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.EmbedLinks, P.AttachFiles,
  P.ReadMessageHistory, P.AddReactions, P.UseExternalEmojis];

export interface ThirdPartyBot {
  readonly name: string;
  /** Its application ID, checked against Discord's public application endpoint on 9 October 2026. */
  readonly clientId: string;
  readonly emoji: string;
  readonly purpose: string;
  /** What its role may do; never Administrator. */
  readonly permissions: string;
  /** When set, the bot sees only these text channels (game bots stay out of the chat). */
  readonly homeChannels?: readonly ChannelKey[];
  /** A channel it may see and make invites for without posting (DISBOARD's listing invite). */
  readonly inviteChannel?: ChannelKey;
}

export const thirdPartyBots: readonly ThirdPartyBot[] = [
  { name: 'Carl-bot', clientId: '235148962103951360', emoji: '🛡️', purpose: 'Reaction roles, logs, embeds and extra automod',
    permissions: bits(...textBot, P.ManageRoles, P.ManageChannels, P.KickMembers, P.BanMembers, P.ModerateMembers,
      P.ManageMessages, P.ManageNicknames, P.ManageWebhooks, P.ViewAuditLog, P.ManageThreads) },
  { name: 'ProBot', clientId: '282859044593598464', emoji: '✨', purpose: 'Welcome images, levels and member logs',
    permissions: bits(...textBot, P.ManageRoles, P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages,
      P.ManageNicknames, P.ViewAuditLog) },
  { name: 'Jockie Music', clientId: '411916947773587456', emoji: '🎵', purpose: 'Music in voice channels',
    permissions: bits(...textBot, P.Connect, P.Speak, P.UseVAD), homeChannels: ['musicCommands'] },
  { name: 'OwO', clientId: '408785106942164992', emoji: '🎲', purpose: 'Hunting, battles and gambling game',
    permissions: bits(...textBot), homeChannels: ['owo'] },
  { name: 'Dank Memer', clientId: '270904126974590976', emoji: '🐸', purpose: 'Economy, memes and mini-games',
    permissions: bits(...textBot), homeChannels: ['dankMemer'] },
  { name: 'Karuta', clientId: '646937666251915264', emoji: '🃏', purpose: 'Collectible card drops and trades',
    permissions: bits(...textBot), homeChannels: ['karuta'] },
  { name: 'GiveawayBot', clientId: '294882584201003009', emoji: '🎉', purpose: 'Giveaways with one command',
    permissions: bits(...textBot) },
  { name: 'DISBOARD', clientId: '302050872383242240', emoji: '🚀', purpose: 'Server listing: /bump brings new members',
    permissions: bits(...textBot, P.CreateInstantInvite), homeChannels: ['bump'], inviteChannel: 'welcome' },
  { name: 'ServerStats', clientId: '458276816071950337', emoji: '📊', purpose: 'Live member and boost counters',
    permissions: bits(P.ViewChannel, P.ManageChannels, P.Connect) },
];

export function botInviteUrl(bot: ThirdPartyBot, guildId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${bot.clientId}&scope=bot%20applications.commands`
    + `&permissions=${bot.permissions}&integration_type=0&guild_id=${guildId}`;
}

function botInvites(guildId: string, channel: (key: ChannelKey) => string): ContainerBuilder {
  const container = new ContainerBuilder()
    .setAccentColor(0x99aab5)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${kicker('🧩', 'Staff')}\n## Recommended bots\n`
      +'Add each one with its button (Discord asks you to authorize it). Then run `npm run support:setup` again: '
      + `every bot gets the ⚙️ Bots role, logs can go to <#${channel('modLog')}>, and game bots only answer in their own channel.`));
  for (const bot of thirdPartyBots) {
    container.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${bot.emoji} **${bot.name}** · ${bot.purpose}`
        + (bot.homeChannels ? `\n-# Answers only in ${bot.homeChannels.map((key) => `<#${channel(key)}>`).join(', ')}` : '')))
      .setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(botInviteUrl(bot, guildId)).setLabel('Add')));
  }
  assertComponentsV2Limit([container]);
  return container;
}

// ---------------------------------------------------------------------------------
// Messages Dealio keeps in the info channels.

export const bannerFileName = 'dealio-banner.png';

export interface InfoMessage {
  readonly channel: ChannelKey;
  readonly container: ContainerBuilder;
  /** Uploaded with the message (the banner). */
  readonly files?: readonly string[];
}

const kicker = (emoji: string, label: string) => `-# ${emoji} DEALIO · ${label.toUpperCase()}`;
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const footerLine = '-# Dealio is free and independent: not affiliated with Valve, Steam or Discord.';

function done(container: ContainerBuilder): ContainerBuilder {
  container.addSeparatorComponents(divider()).addTextDisplayComponents(new TextDisplayBuilder().setContent(footerLine));
  assertComponentsV2Limit([container]);
  return container;
}

function welcome(clientId: string, channel: (key: ChannelKey) => string): ContainerBuilder {
  const c = (key: ChannelKey) => `<#${channel(key)}>`;
  return done(new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.primary)
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(`attachment://${bannerFileName}`).setDescription('Dealio'),
    ))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${kicker('👋', 'Welcome')}\n# Welcome to Dealio!\n`
        + 'Dealio follows your **public Steam wishlist** and sends you a DM when a game hits **your** rule: '
        + 'a discount you pick, or a target price per game. No Steam password, no channel spam, '
        + 'and it speaks English, Turkish, German and French.'),
      new TextDisplayBuilder().setContent('### Get started in a minute\n'
        + '**1.** Add Dealio to a server or to your apps with the button below.\n'
        + '**2.** Run `/dealio` and paste your Steam profile link. Your profile and game details must be public.\n'
        + '**3.** Pick your Steam Store country and your discount rule. Done: deals come to your DMs.'),
      new TextDisplayBuilder().setContent('### Find your way around\n'
        + `📜 ${c('rules')} · please read them first\n`
        + `❓ ${c('faq')} · quick answers\n`
        + `🎫 ${c('tickets')} · private help from the team\n`
        + `📣 ${c('announcements')} · releases and status\n`
        + `🤖 ${c('tryDealio')} · try /dealio right here\n`
        + `💡 ${c('suggestions')} · ideas for Dealio\n`
        + `💝 ${c('supportDealio')} · Donator roles and perks\n`
        + `🔥 ${c('deals')} · share deals · 🏆 ${c('dealWins')} · show what you saved\n`
        + `🌍 ${c('turkish')} · ${c('german')} · ${c('french')} · chat in your language\n`
        + `🎮 ${c('owo')} · ${c('lfg')} · games, bots and finding teammates\n`
        + `🔊 ${c('voiceLounge')} · hang out in voice`),
    )
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.invite(clientId)).setEmoji('➕').setLabel('Add Dealio'),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.website).setEmoji('🌐').setLabel('Website'),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.help).setEmoji('📖').setLabel('Help center'),
    ))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# Share it: **dsc.gg/dealio** adds the bot · **dsc.gg/dealiosupport** invites friends here\n`
      + `-# [Privacy policy](${links.privacy}) · [Terms](${links.terms}) · [Source code](${links.github})`)));
}

const ruleList = [
  ['Be kind', 'Respect everyone. No harassment, hate speech, discrimination or personal attacks.'],
  ['Keep it safe for work', 'No NSFW, gore or shocking content, in messages, names or avatars.'],
  ['No spam or ads', 'No unsolicited promotion, server invites, referral or affiliate links, here or in members’ DMs.'],
  ['Protect your accounts', 'Never share passwords, tokens or login codes. The Dealio team will never ask for them, and never DMs you first.'],
  ['No piracy or shady trading', 'No cracks, cheats, account trading or grey-market key reselling.'],
  ['Use the right place', 'Account problems go in a ticket, ideas in suggestions, deals in deals, bot games in 🎮 Games & Bots. Write in English in public channels; Türkçe, Deutsch and Français have their own channels under 🌍 International.'],
  ['Follow Discord’s rules', `Discord’s [Terms of Service](${links.discordTerms}) and [Community Guidelines](${links.discordGuidelines}) apply here.`],
] as const;

function rules(channel: (key: ChannelKey) => string): ContainerBuilder {
  return done(new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.warning)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${kicker('📜', 'Rules')}\n# Server rules\nShort and simple, so this stays a friendly place to get help.`),
      new TextDisplayBuilder().setContent(ruleList.map(([title, text], index) => `**${index + 1}. ${title}**\n${text}`).join('\n\n')),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      'The team may remove messages, time out or remove members who break these rules. '
      + `If you disagree with a moderation decision, open a ticket in <#${channel('tickets')}>.\n`
      + '-# For moderation, Carl-bot logs deleted and edited messages, joins, leaves and role changes in a channel only the team can see.')));
}

const faqList: readonly (readonly [string, string])[] = [
  ['How do I start?', 'Run `/dealio`, paste your Steam profile link (or custom URL name, or SteamID64), then pick your Steam Store country and your discount rule. Dealio shows your Steam name and region before saving anything.'],
  ['Does Dealio need my Steam password?', 'No, never. It only reads your **public** wishlist. In Steam’s privacy settings, your profile and “Game details” must be public.'],
  ['When do I get a DM?', 'Dealio checks about every 30 minutes and right after Steam’s daily price change (10:00 Pacific). You get a DM when a game goes on sale and meets your rule, or reaches your target price. During the same sale it alerts again only if the deal gets clearly better.'],
  ['I didn’t get an alert', 'Open `/dealio` → 🔔 Alerts and check the history: quiet hours or a daily digest may be holding it. Make sure Discord allows DMs from Dealio, send a Test DM from ⚙️ Settings, and press Resume tracking if tracking was paused.'],
  ['Why is the price in another currency?', 'Prices follow the Steam Store country you picked, exactly as Steam shows them; Dealio never converts currencies. Change the country in ⚙️ Settings.'],
  ['What does “Coming soon”, “not sold” or “removed” mean?', 'The game has no price yet, isn’t sold in your Store country, or was removed from Steam. These never count as errors.'],
  ['My panel stopped responding', 'Panels close after a while for safety. Run `/dealio` again; tracking keeps running in the background.'],
  ['How do I delete my data?', 'Run `/delete-data` (or ⚙️ Settings → Delete my data). It removes your setup, rules, history and support tickets from Dealio.'],
  ['Is Dealio free?', 'Yes, completely. If you’d like to support it, there’s a ☕ button on the Home panel.'],
];

function faq(channel: (key: ChannelKey) => string): ContainerBuilder {
  return done(new ContainerBuilder()
    .setAccentColor(dealioBrand.colors.success)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${kicker('❓', 'FAQ')}\n# Frequently asked questions`),
      new TextDisplayBuilder().setContent(faqList.map(([question, answer]) => `**${question}**\n${answer}`).join('\n\n')),
    )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `Still stuck? Open a ticket in <#${channel('tickets')}> and the team will help you privately.`))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(links.help).setEmoji('📖').setLabel('Full help center'),
    )));
}

/** Coffees in total for each Donator tier; the owner hands the roles out. */
export const donatorTiers = [
  { key: 'donator', text: 'Any coffee, any time. Thank you!' },
  { key: 'superDonator', text: 'Five coffees in total.' },
  { key: 'legend', text: 'Ten coffees in total: a true Dealio legend.' },
] as const;

function supportDealio(channel: (key: ChannelKey) => string, roleId: (key: RoleKey) => string | undefined): ContainerBuilder {
  const role = (key: RoleKey) => {
    const id = roleId(key);
    return id ? `<@&${id}>` : `**${roles.find((candidate) => candidate.key === key)!.name}**`;
  };
  return done(new ContainerBuilder()
    .setAccentColor(0xff7eb3)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`${kicker('💝', 'Support Dealio')}\n# Keep Dealio free for everyone\n`
        + 'Dealio has no ads, no paywall and no premium tier. '
        + 'It runs on one small server that its developer pays for. If Dealio saved you money, '
        + 'a coffee helps keep it running, and you get a shiny role as a thank-you.'),
      new TextDisplayBuilder().setContent('### Donator roles\n'
        + donatorTiers.slice().reverse().map((tier) => `${role(tier.key)} · ${tier.text}`).join('\n')),
      new TextDisplayBuilder().setContent(`### Boost the server\n${role('booster')} · Discord gives you this role automatically while you boost.`),
      new TextDisplayBuilder().setContent('### What you get\n'
        + '✨ Your own colour and your own spot in the member list\n'
        + `💖 Access to <#${channel('lounge')}>\n`
        + '🙏 Our honest gratitude: every coffee goes to keeping Dealio online'),
      new TextDisplayBuilder().setContent('### How to get your Donator role\n'
        + `Buy a coffee, then open a ticket in <#${channel('tickets')}> (topic: *Something else*) with the name you used on Buy Me a Coffee. `
        + 'The team adds your role by hand, usually within a day.'),
    )
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(buyMeACoffeeUrl).setEmoji('☕').setLabel('Buy Dealio a coffee'),
    )));
}

export function infoMessages(
  clientId: string,
  channel: (key: ChannelKey) => string,
  bannerPath: string,
  roleId: (key: RoleKey) => string | undefined = () => undefined,
  guildId?: string,
): InfoMessage[] {
  return [
    ...(guildId ? [{ channel: 'staffChat' as const, container: botInvites(guildId, channel) }] : []),
    { channel: 'welcome', container: welcome(clientId, channel), files: [bannerPath] },
    { channel: 'rules', container: rules(channel) },
    { channel: 'faq', container: faq(channel) },
    { channel: 'supportDealio', container: supportDealio(channel, roleId) },
    { channel: 'tickets', container: buildSupportPanel('en', { faqChannelId: channel('faq') }) },
  ];
}

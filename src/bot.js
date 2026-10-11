import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits
} from 'discord.js';
import {
  db, getSettings, setSetting, ensureUser, getUser,
  getFilterMode, getFilterEntries, setFilterMode,
  addFilterEntry, removeFilterEntry, setMemberExcluded,
  addAudit
} from './database.js';
import {
  COMPONENTS_V2_FLAG, textDisplay, separator, actionRow, button,
  sendV2, buildRankCard, buildLeaderboardCard,
  buildSettingsPanel, buildHelpCard, buildLevelUpPanel, buildChatXpPanel, buildVoiceXpPanel,
  buildFilterPanel, buildMultiplierPanel, buildRewardsPanel
} from './components.js';
import {
  grantXp, setUserXp, resetUserXp, resetGuildXp, isXpAllowed, getXpMultiplier, randomInteger
} from './leveling.js';
import { handleSlashCommand } from './slash-handlers.js';

if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN === 'put_your_bot_token_here') {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and add your Discord bot token.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const voiceSessions = new Map();
const uiSessions = new Map(); // state for interactive Components V2 panels, keyed by message ID
let voiceTickRunning = false;

const componentMessage = (channel, components, options = {}) => channel.send({
  flags: COMPONENTS_V2_FLAG,
  components,
  allowedMentions: options.allowedMentions ?? { parse: [] }
});

async function replyCard(message, title, body, accentColor = 0x5865F2) {
  return sendV2(message.channel, [textDisplay(`# ${title}`), separator(), textDisplay(body)], { accentColor });
}

async function sendInteractivePanel(channel, panel, components, state = {}) {
  const sent = await componentMessage(channel, components);
  uiSessions.set(sent.id, { panel, ...state });
  if (uiSessions.size > 500) uiSessions.delete(uiSessions.keys().next().value);
  return sent;
}

function currentUiSession(interaction, panel, defaults = {}) {
  return { ...(uiSessions.get(interaction.message?.id) || { panel, ...defaults }) };
}

async function updateInteractivePanel(interaction, panel, components, state = {}) {
  if (interaction.message?.id) {
    uiSessions.set(interaction.message.id, { panel, ...state });
    if (uiSessions.size > 500) uiSessions.delete(uiSessions.keys().next().value);
  }
  return interaction.update({ components, allowedMentions: { parse: [] } });
}

function modalField(customId, label, options = {}) {
  return {
    type: 1,
    components: [{
      type: 4,
      custom_id: customId,
      label: String(label).slice(0, 45),
      style: options.paragraph ? 2 : 1,
      required: options.required !== false,
      min_length: options.minLength ?? 1,
      max_length: options.maxLength ?? 100,
      ...(options.placeholder ? { placeholder: String(options.placeholder).slice(0, 100) } : {}),
      ...(options.value != null && String(options.value).length ? { value: String(options.value).slice(0, options.maxLength ?? 100) } : {})
    }]
  };
}

async function showInputModal(interaction, customId, title, fields) {
  return interaction.showModal({
    custom_id: customId,
    title: String(title).slice(0, 45),
    components: fields
  });
}

async function replyWithInteractivePanel(interaction, panel, components, state = {}) {
  await interaction.reply({
    flags: COMPONENTS_V2_FLAG | 64,
    components,
    allowedMentions: { parse: [] }
  });
  const response = await interaction.fetchReply().catch(() => null);
  if (response?.id) uiSessions.set(response.id, { panel, ...state });
}

function canManageInteraction(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.guild?.ownerId === interaction.user.id);
}

async function requireComponentAdmin(interaction) {
  if (canManageInteraction(interaction)) return true;
  await interaction.reply({ content: 'Only members with Manage Server can change XP settings.', ephemeral: true }).catch(() => {});
  return false;
}

function hasManageServer(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild) || member?.guild?.ownerId === member?.id);
}

async function requireAdmin(message) {
  if (hasManageServer(message.member)) return true;
  await replyCard(message, 'Permission required', 'This command requires **Manage Server** permission.');
  return false;
}

function extractId(token) {
  if (!token) return null;
  const match = String(token).match(/\d{15,22}/);
  return match?.[0] || null;
}

function mentionedUser(message, token) {
  return message.mentions.users.first() || (extractId(token) ? { id: extractId(token) } : null);
}

function mentionedChannel(message, token) {
  const mentioned = message.mentions.channels.first();
  if (mentioned) return mentioned;
  const raw = String(token || '').trim();
  if (!raw) return null;
  const mentionMatch = raw.match(/^<#(\d{15,22})>$/);
  const idMatch = raw.match(/^(\d{15,22})$/);
  const id = mentionMatch?.[1] || idMatch?.[1] || null;
  if (id) return message.guild.channels.cache.get(id) || null;
  // Also accept a channel name such as: !levelup channel level-ups
  const name = raw.replace(/^#/, '').toLowerCase();
  return message.guild.channels.cache.find(channel => channel.name?.toLowerCase() === name) || null;
}

function mentionedRole(message, token) {
  return message.mentions.roles.first() || (extractId(token) ? message.guild.roles.cache.get(extractId(token)) : null);
}

async function resolveMember(message, token) {
  const user = mentionedUser(message, token);
  if (!user) return null;
  return message.guild.members.fetch(user.id).catch(() => null);
}

function validateScope(scope) {
  return ['chat', 'voice'].includes(String(scope || '').toLowerCase());
}

async function commandRank(message, args) {
  const target = mentionedUser(message, args[0]);
  let user = message.author;
  if (target && target.id !== message.author.id) {
    user = await client.users.fetch(target.id).catch(() => null);
    if (!user) return replyCard(message, 'Member not found', 'I could not find that Discord user.');
  }
  const components = await buildRankCard(message.guild, user);
  return componentMessage(message.channel, components);
}

async function commandLeaderboard(message, args) {
  const scope = ['all', 'chat', 'voice'].includes(String(args[0] || 'all').toLowerCase()) ? String(args[0] || 'all').toLowerCase() : 'all';
  const pageToken = ['all', 'chat', 'voice'].includes(String(args[0] || '').toLowerCase()) ? args[1] : args[0];
  const page = Math.max(1, Number.parseInt(pageToken || '1', 10) || 1);
  return componentMessage(message.channel, buildLeaderboardCard(message.guild, scope, page));
}

async function commandPrefix(message, args) {
  if (!args.length) {
    const prefix = getSettings(message.guild.id).prefix;
    return replyCard(message, 'Server prefix', `The current prefix is \`${prefix}\`. Change it with \`${prefix}prefix set <new-prefix>\`.`);
  }
  if (String(args[0]).toLowerCase() !== 'set' || !args[1]) {
    return replyCard(message, 'Prefix usage', `Use \`${getSettings(message.guild.id).prefix}prefix set <new-prefix>\` (1–5 characters, no spaces).`);
  }
  if (!(await requireAdmin(message))) return;
  const prefix = String(args[1]);
  if (prefix.length < 1 || prefix.length > 5 || /\s/.test(prefix) || /<@!?\d+>/.test(prefix)) {
    return replyCard(message, 'Invalid prefix', 'Choose a prefix that is 1–5 characters long and contains no spaces or user mention.');
  }
  setSetting(message.guild.id, 'prefix', prefix);
  addAudit(message.guild.id, message.author.id, 'prefix_set', null, prefix);
  return replyCard(message, 'Prefix updated', `The new prefix is \`${prefix}\`. Use \`${prefix}help\` to see commands.`, 0x57F287);
}

async function commandSettings(message) {
  if (!(await requireAdmin(message))) return;
  return sendInteractivePanel(message.channel, 'settings', buildSettingsPanel(message.guild));
}

async function commandChatXp(message, args) {
  if (!(await requireAdmin(message))) return;
  if (!args.length) return sendInteractivePanel(message.channel, 'chatxp', buildChatXpPanel(message.guild));
  const settings = getSettings(message.guild.id);
  const action = String(args[0] || '').toLowerCase();
  if (['on', 'off', 'enable', 'disable', 'toggle'].includes(action)) {
    const enabled = action === 'toggle' ? (settings.chat_enabled ? 0 : 1) : (['on', 'enable'].includes(action) ? 1 : 0);
    setSetting(message.guild.id, 'chat_enabled', enabled);
    addAudit(message.guild.id, message.author.id, 'chat_xp_toggle', null, Boolean(enabled));
    return replyCard(message, 'Chat XP updated', `Chat XP is now **${enabled ? 'enabled' : 'disabled'}**.` , enabled ? 0x57F287 : 0xED4245);
  }
  if (action === 'range') {
    const min = Number.parseInt(args[1], 10);
    const max = Number.parseInt(args[2], 10);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 1000) {
      return replyCard(message, 'Usage', `Use \`${settings.prefix}chatxp range <min> <max>\` (1–1000 XP).`);
    }
    setSetting(message.guild.id, 'chat_xp_min', min);
    setSetting(message.guild.id, 'chat_xp_max', max);
    return replyCard(message, 'Chat XP range updated', `Each eligible message now grants **${min}–${max} XP** before multipliers.`, 0x57F287);
  }
  if (action === 'cooldown') {
    const seconds = Number.parseInt(args[1], 10);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) return replyCard(message, 'Usage', `Use \`${settings.prefix}chatxp cooldown <seconds>\` (5–3600).`);
    setSetting(message.guild.id, 'chat_cooldown_seconds', seconds);
    return replyCard(message, 'Cooldown updated', `Chat XP cooldown is now **${seconds} seconds**.`, 0x57F287);
  }
  if (action === 'minlength') {
    const length = Number.parseInt(args[1], 10);
    if (!Number.isInteger(length) || length < 1 || length > 500) return replyCard(message, 'Usage', `Use \`${settings.prefix}chatxp minlength <characters>\` (1–500).`);
    setSetting(message.guild.id, 'min_message_length', length);
    return replyCard(message, 'Minimum message length updated', `Eligible messages must contain at least **${length} non-space characters**.`, 0x57F287);
  }
  return replyCard(message, 'Chat XP configuration', `Status: **${settings.chat_enabled ? 'enabled' : 'disabled'}**\nRange: ${settings.chat_xp_min}–${settings.chat_xp_max} XP\nCooldown: ${settings.chat_cooldown_seconds}s\nMinimum length: ${settings.min_message_length}\n\nCommands: \`${settings.prefix}chatxp on|off\`, \`range <min> <max>\`, \`cooldown <seconds>\`, \`minlength <characters>\`.`);
}

async function commandVoiceXp(message, args) {
  if (!(await requireAdmin(message))) return;
  if (!args.length) return sendInteractivePanel(message.channel, 'voicexp', buildVoiceXpPanel(message.guild));
  const settings = getSettings(message.guild.id);
  const action = String(args[0] || '').toLowerCase();
  if (['on', 'off', 'enable', 'disable', 'toggle'].includes(action)) {
    const enabled = action === 'toggle' ? (settings.voice_enabled ? 0 : 1) : (['on', 'enable'].includes(action) ? 1 : 0);
    setSetting(message.guild.id, 'voice_enabled', enabled);
    addAudit(message.guild.id, message.author.id, 'voice_xp_toggle', null, Boolean(enabled));
    return replyCard(message, 'Voice XP updated', `Voice XP is now **${enabled ? 'enabled' : 'disabled'}**.`, enabled ? 0x57F287 : 0xED4245);
  }
  if (action === 'range') {
    const min = Number.parseInt(args[1], 10);
    const max = Number.parseInt(args[2], 10);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 1000) {
      return replyCard(message, 'Usage', `Use \`${settings.prefix}voicexp range <min> <max>\` (1–1000 XP per eligible interval).`);
    }
    setSetting(message.guild.id, 'voice_xp_min', min);
    setSetting(message.guild.id, 'voice_xp_max', max);
    return replyCard(message, 'Voice XP range updated', `Each eligible interval now grants **${min}–${max} XP** before multipliers.`, 0x57F287);
  }
  if (action === 'interval') {
    const seconds = Number.parseInt(args[1], 10);
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) return replyCard(message, 'Usage', `Use \`${settings.prefix}voicexp interval <seconds>\` (30–3600).`);
    setSetting(message.guild.id, 'voice_interval_seconds', seconds);
    return replyCard(message, 'Voice XP interval updated', `Eligible members earn voice XP every **${seconds} seconds**.`, 0x57F287);
  }
  return replyCard(message, 'Voice XP configuration', `Status: **${settings.voice_enabled ? 'enabled' : 'disabled'}**\nRange: ${settings.voice_xp_min}–${settings.voice_xp_max} XP\nInterval: ${settings.voice_interval_seconds}s\n\nCommands: \`${settings.prefix}voicexp on|off\`, \`range <min> <max>\`, \`interval <seconds>\`.`);
}

async function commandLevelUp(message, args) {
  if (!(await requireAdmin(message))) return;
  if (!args.length) return sendInteractivePanel(message.channel, 'levelup', buildLevelUpPanel(message.guild));
  const settings = getSettings(message.guild.id);
  const action = String(args[0] || 'show').toLowerCase();

  if (['on', 'enable', 'enabled'].includes(action)) {
    setSetting(message.guild.id, 'levelup_enabled', 1);
    addAudit(message.guild.id, message.author.id, 'levelup_toggle', null, true);
    return replyCard(message, 'Level-up notifications enabled', 'Level-up notifications are now **enabled**.', 0x57F287);
  }
  if (['off', 'disable', 'disabled'].includes(action)) {
    setSetting(message.guild.id, 'levelup_enabled', 0);
    addAudit(message.guild.id, message.author.id, 'levelup_toggle', null, false);
    return replyCard(message, 'Level-up notifications disabled', 'Level-up notifications are now **disabled**.', 0xED4245);
  }
  if (action === 'toggle') {
    const enabled = settings.levelup_enabled ? 0 : 1;
    setSetting(message.guild.id, 'levelup_enabled', enabled);
    addAudit(message.guild.id, message.author.id, 'levelup_toggle', null, Boolean(enabled));
    return replyCard(message, 'Level-up notifications', `Level-up notifications are now **${enabled ? 'enabled' : 'disabled'}**.`, enabled ? 0x57F287 : 0xED4245);
  }
  if (action === 'channel') {
    const token = args[1];
    const destination = String(token || '').toLowerCase();
    if (['current', 'auto', 'automatic'].includes(destination)) {
      const mode = destination === 'current' ? 'current' : 'auto';
      setSetting(message.guild.id, 'levelup_mode', mode);
      setSetting(message.guild.id, 'levelup_channel_id', null);
      addAudit(message.guild.id, message.author.id, 'levelup_destination', null, mode);
      return replyCard(message, 'Level-up destination updated', mode === 'current'
        ? 'Chat level-ups will be sent in the channel where the member levels up; voice level-ups use the server system channel or a permitted fallback.'
        : 'Level-up destination is set to **Automatic**.', 0x57F287);
    }
    if (destination === 'system') {
      setSetting(message.guild.id, 'levelup_mode', 'system');
      setSetting(message.guild.id, 'levelup_channel_id', null);
      addAudit(message.guild.id, message.author.id, 'levelup_destination', null, 'system');
      return replyCard(message, 'Level-up destination updated', 'Level-up notices will use the server system channel when available.', 0x57F287);
    }
    if (destination === 'dm') {
      setSetting(message.guild.id, 'levelup_mode', 'dm');
      setSetting(message.guild.id, 'levelup_channel_id', null);
      addAudit(message.guild.id, message.author.id, 'levelup_destination', null, 'dm');
      return replyCard(message, 'Level-up destination updated', 'Level-up notices will be sent by DM. The bot may be unable to DM members who block server DMs.', 0x57F287);
    }
    const channel = mentionedChannel(message, token);
    if (!channel || !channel.isTextBased?.() || typeof channel.send !== 'function') {
      return replyCard(message, 'Channel not found', `Use \`${settings.prefix}levelup channel #level-ups\`, \`${settings.prefix}levelup channel level-ups\`, or provide the channel ID. You can also choose \`current\`, \`auto\`, \`system\`, or \`dm\`.`);
    }
    const botMember = message.guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
      return replyCard(message, 'Missing channel permissions', `I need **View Channel** and **Send Messages** in ${channel}. No settings were changed.`);
    }
    setSetting(message.guild.id, 'levelup_mode', 'channel');
    setSetting(message.guild.id, 'levelup_channel_id', channel.id);
    addAudit(message.guild.id, message.author.id, 'levelup_destination', channel.id, 'channel');
    return replyCard(message, 'Level-up destination saved', `Level-up notices will be sent to ${channel}. Notifications are currently **${getSettings(message.guild.id).levelup_enabled ? 'enabled' : 'disabled'}**. Use \`${settings.prefix}levelup enable\` to enable them explicitly.`, 0x57F287);
  }
  if (action === 'message') {
    const template = args.slice(1).join(' ').trim();
    if (!template) return replyCard(message, 'Usage', `Use \`${settings.prefix}levelup message <text>\`. Placeholders: \`{user}\`, \`{level}\`, \`{server}\`, \`{xp}\`.`);
    if (template.length > 1500) return replyCard(message, 'Template too long', 'Keep the level-up template under 1500 characters.');
    setSetting(message.guild.id, 'levelup_message', template);
    addAudit(message.guild.id, message.author.id, 'levelup_message', null, template);
    return replyCard(message, 'Level-up template updated', `Preview (placeholders are shown literally):\n\n${template}`, 0x57F287);
  }
  if (action !== 'show') return replyCard(message, 'Level-up command usage', `\`${settings.prefix}levelup enable\` · \`${settings.prefix}levelup disable\` · \`${settings.prefix}levelup channel #level-ups\` · \`${settings.prefix}levelup show\` · \`${settings.prefix}levelup message <text>\`.`);
  const latest = getSettings(message.guild.id);
  const status = latest.levelup_enabled ? 'enabled' : 'disabled';
  const destinationLabel = latest.levelup_channel_id ? `<#${latest.levelup_channel_id}>` : latest.levelup_mode;
  return replyCard(message, 'Level-up configuration', `Status: **${status}**\nDestination mode: **${latest.levelup_mode}**\nDestination: ${destinationLabel}\nTemplate: ${latest.levelup_message}\n\nCommands: \`${latest.prefix}levelup enable|disable|toggle\`, \`channel <#channel|channel-name|channel-id|current|auto|system|dm>\`, \`message <text>\`.`, 0x5865F2);
}

async function commandFilter(message, args) {
  if (!(await requireAdmin(message))) return;
  if (!args.length) return sendInteractivePanel(message.channel, 'filter', buildFilterPanel(message.guild), { kind: 'channel', scope: 'chat', targetId: null, targetLabel: null, notice: '' });
  const kind = String(args[0] || '').toLowerCase();
  const scope = String(args[1] || '').toLowerCase();
  const action = String(args[2] || '').toLowerCase();
  const settings = getSettings(message.guild.id);

  if (!['channel', 'role', 'member'].includes(kind)) {
    return replyCard(message, 'Filter usage', `\`${settings.prefix}filter channel <chat|voice> mode <whitelist|blacklist>\`\n\`${settings.prefix}filter channel <chat|voice> add|remove|list [#channel]\`\n\`${settings.prefix}filter role <chat|voice> mode <whitelist|blacklist>\`\n\`${settings.prefix}filter role <chat|voice> add|remove|list [@role]\`\n\`${settings.prefix}filter member <chat|voice|all> exclude|include|list [@user]\``);
  }

  if (kind === 'member') {
    if (!['chat', 'voice', 'all'].includes(scope)) return replyCard(message, 'Invalid scope', 'Choose `chat`, `voice`, or `all`.');
    if (action === 'list') {
      const rows = db.prepare('SELECT user_id, scope FROM excluded_members WHERE guild_id = ? AND (scope = ? OR scope = \'all\' OR ? = \'all\') ORDER BY created_at DESC LIMIT 50').all(message.guild.id, scope, scope);
      const body = rows.length ? rows.map(row => `<@${row.user_id}> — **${row.scope}**`).join('\n') : 'No excluded members found for this scope.';
      return replyCard(message, 'Excluded members', body);
    }
    if (!['exclude', 'include'].includes(action)) return replyCard(message, 'Invalid action', `Use \`${settings.prefix}filter member ${scope} exclude|include @user\`.`);
    const user = mentionedUser(message, args[3]);
    if (!user) return replyCard(message, 'User required', 'Mention a member or provide their user ID.');
    setMemberExcluded(message.guild.id, user.id, scope, action === 'exclude');
    addAudit(message.guild.id, message.author.id, `member_filter_${action}`, user.id, scope);
    return replyCard(message, 'Member filter updated', `${user.id === message.author.id ? 'You' : `<@${user.id}>`} ${action === 'exclude' ? 'will not earn' : 'can earn'} ${scope === 'all' ? 'chat or voice' : scope} XP.`, 0x57F287);
  }

  if (!validateScope(scope)) return replyCard(message, 'Invalid scope', 'Choose `chat` or `voice`.');
  if (action === 'mode') {
    const mode = String(args[3] || '').toLowerCase();
    if (!['whitelist', 'blacklist'].includes(mode)) return replyCard(message, 'Invalid mode', 'Choose `whitelist` or `blacklist`.');
    setFilterMode(message.guild.id, scope, kind, mode);
    addAudit(message.guild.id, message.author.id, 'filter_mode_set', null, `${kind}/${scope}/${mode}`);
    const entries = getFilterEntries(message.guild.id, scope, kind).length;
    const warning = mode === 'whitelist' && entries === 0 ? '\n⚠️ The whitelist is empty, so no channels/roles currently qualify.' : '';
    return replyCard(message, 'Filter mode updated', `${kind} ${scope} filter is now **${mode}**. Entries: ${entries}.${warning}`, 0x57F287);
  }
  if (action === 'list') {
    const ids = getFilterEntries(message.guild.id, scope, kind);
    const body = ids.length ? ids.map(id => {
      const found = kind === 'channel' ? message.guild.channels.cache.get(id) : message.guild.roles.cache.get(id);
      return `• ${found ? `${found}` : (kind === 'channel' ? `<#${id}>` : `<@&${id}>`)}`;
    }).join('\n') : 'No entries configured.';
    return replyCard(message, `${kind[0].toUpperCase()}${kind.slice(1)} filters · ${scope}`, `Mode: **${getFilterMode(message.guild.id, scope, kind)}**\n${body}`);
  }
  if (!['add', 'remove'].includes(action)) return replyCard(message, 'Invalid action', `Use \`${settings.prefix}filter ${kind} ${scope} add|remove|list\`.`);
  const target = kind === 'channel' ? mentionedChannel(message, args[3]) : mentionedRole(message, args[3]);
  if (!target) return replyCard(message, 'Target required', kind === 'channel' ? 'Mention a channel or provide its ID.' : 'Mention a role or provide its ID.');
  const changed = action === 'add'
    ? addFilterEntry(message.guild.id, scope, kind, target.id)
    : removeFilterEntry(message.guild.id, scope, kind, target.id);
  addAudit(message.guild.id, message.author.id, `filter_${action}`, target.id, `${kind}/${scope}`);
  return replyCard(message, 'Filter updated', `${target} ${changed ? (action === 'add' ? 'added to' : 'removed from') : (action === 'add' ? 'was already in' : 'was not in')} the **${scope} ${kind} ${getFilterMode(message.guild.id, scope, kind)}** list.`, 0x57F287);
}

async function commandMultipliers(message, args) {
  if (!(await requireAdmin(message))) return;
  if (!args.length) return sendInteractivePanel(message.channel, 'multipliers', buildMultiplierPanel(message.guild), { targetType: 'channel', targetId: null, targetLabel: null, notice: '' });
  const sub = String(args[0] || '').toLowerCase();
  if (['toggle', 'on', 'off', 'enable', 'disable'].includes(sub)) {
    const current = getSettings(message.guild.id).multipliers_enabled;
    const enabled = sub === 'toggle' ? (current ? 0 : 1) : (['on', 'enable'].includes(sub) ? 1 : 0);
    setSetting(message.guild.id, 'multipliers_enabled', enabled);
    addAudit(message.guild.id, message.author.id, 'multipliers_toggle', null, Boolean(enabled));
    return replyCard(message, 'XP multiplier system', `The multiplier system is now **${enabled ? 'enabled' : 'disabled'}**. ${enabled ? 'Configured channel and role multipliers will be applied.' : 'All members receive base XP until it is enabled again.'}`, enabled ? 0x57F287 : 0xED4245);
  }
  if (sub === 'list') {
    const rows = db.prepare('SELECT target_type, target_id, multiplier FROM xp_multipliers WHERE guild_id = ? ORDER BY target_type, target_id').all(message.guild.id);
    const body = rows.length ? rows.map(row => {
      const target = row.target_type === 'channel' ? message.guild.channels.cache.get(row.target_id) : message.guild.roles.cache.get(row.target_id);
      return `• ${row.target_type}: ${target || row.target_id} — **×${row.multiplier}**`;
    }).join('\n') : 'No multipliers configured. All eligible members receive the base XP amount.';
    return replyCard(message, 'XP multipliers', `${body}\n\nMultipliers stack, with a final cap of ×5.`);
  }
  if (sub === 'remove') {
    const targetType = String(args[1] || '').toLowerCase();
    if (!['channel', 'role'].includes(targetType)) return replyCard(message, 'Usage', `Use \`${getSettings(message.guild.id).prefix}multiplier remove <channel|role> <target>\`.`);
    const target = targetType === 'channel' ? mentionedChannel(message, args[2]) : mentionedRole(message, args[2]);
    if (!target) return replyCard(message, 'Target required', 'Mention a channel/role or provide its ID.');
    const result = db.prepare('DELETE FROM xp_multipliers WHERE guild_id = ? AND target_type = ? AND target_id = ?').run(message.guild.id, targetType, target.id);
    addAudit(message.guild.id, message.author.id, 'multiplier_remove', target.id, targetType);
    return replyCard(message, 'Multiplier removed', result.changes ? `Removed the multiplier for ${target}.` : `No multiplier was configured for ${target}.`, 0x57F287);
  }
  const targetType = sub;
  if (!['channel', 'role'].includes(targetType)) return replyCard(message, 'Multiplier usage', `\`${getSettings(message.guild.id).prefix}multiplier channel #channel <0.1–5>\`\n\`${getSettings(message.guild.id).prefix}multiplier role @role <0.1–5>\`\n\`${getSettings(message.guild.id).prefix}multiplier remove <channel|role> <target>\`\n\`${getSettings(message.guild.id).prefix}multiplier list\``);
  const target = targetType === 'channel' ? mentionedChannel(message, args[1]) : mentionedRole(message, args[1]);
  const multiplier = Number.parseFloat(args[2]);
  if (!target || !Number.isFinite(multiplier) || multiplier < 0.1 || multiplier > 5) return replyCard(message, 'Invalid multiplier', 'Choose a channel/role and a multiplier between **0.1 and 5**. Example: `!multiplier role @VIP 1.5`.');
  db.prepare(`INSERT INTO xp_multipliers (guild_id, target_type, target_id, multiplier, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, target_type, target_id)
    DO UPDATE SET multiplier = excluded.multiplier, updated_at = excluded.updated_at`)
    .run(message.guild.id, targetType, target.id, multiplier, Date.now());
  addAudit(message.guild.id, message.author.id, 'multiplier_set', target.id, `${targetType}/${multiplier}`);
  return replyCard(message, 'Multiplier saved', `${target} now has an XP multiplier of **×${multiplier}**. Multipliers stack, with a final cap of ×5.`, 0x57F287);
}

async function commandRewards(message, args) {
  if (!(await requireAdmin(message))) return;
  if (!args.length) return sendInteractivePanel(message.channel, 'rewards', buildRewardsPanel(message.guild), { roleId: null, level: null, notice: '' });
  const sub = String(args[0] || '').toLowerCase();
  if (sub === 'list') {
    const rows = db.prepare('SELECT level, role_id FROM level_rewards WHERE guild_id = ? ORDER BY level').all(message.guild.id);
    const body = rows.length ? rows.map(row => `• Level **${row.level}** → <@&${row.role_id}>`).join('\n') : 'No level rewards configured.';
    return replyCard(message, 'Level role rewards', body);
  }
  if (sub === 'remove') {
    const level = Number.parseInt(args[1], 10);
    if (!Number.isInteger(level) || level < 1) return replyCard(message, 'Usage', `Use \`${getSettings(message.guild.id).prefix}rewards remove <level>\`.`);
    const result = db.prepare('DELETE FROM level_rewards WHERE guild_id = ? AND level = ?').run(message.guild.id, level);
    addAudit(message.guild.id, message.author.id, 'reward_remove', null, level);
    return replyCard(message, 'Level reward removed', result.changes ? `Removed the role reward at level ${level}.` : `No role reward was set for level ${level}.`, 0x57F287);
  }
  if (sub !== 'add') return replyCard(message, 'Reward usage', `\`${getSettings(message.guild.id).prefix}rewards add <level> @role\`\n\`${getSettings(message.guild.id).prefix}rewards remove <level>\`\n\`${getSettings(message.guild.id).prefix}rewards list\``);
  const level = Number.parseInt(args[1], 10);
  const role = mentionedRole(message, args[2]);
  if (!Number.isInteger(level) || level < 1 || level > 10000 || !role) return replyCard(message, 'Invalid reward', 'Provide a level between 1 and 10000 and mention a role.');
  const botMember = message.guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return replyCard(message, 'Missing permission', 'The bot needs **Manage Roles** to assign level rewards.');
  if (role.managed || role.position >= botMember.roles.highest.position) return replyCard(message, 'Role hierarchy issue', 'Move the bot role above the reward role, and do not use an integration-managed role.');
  db.prepare(`INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id`)
    .run(message.guild.id, level, role.id);
  addAudit(message.guild.id, message.author.id, 'reward_set', role.id, level);
  return replyCard(message, 'Level reward saved', `Members will receive ${role} when they reach level **${level}**. If they jump over multiple levels at once, crossed-level rewards are also checked.`, 0x57F287);
}

async function commandXpAdmin(message, args) {
  if (!(await requireAdmin(message))) return;
  const action = String(args[0] || '').toLowerCase();
  const settings = getSettings(message.guild.id);
  if (!['add', 'remove', 'set', 'reset'].includes(action)) {
    return replyCard(message, 'XP admin usage', `\`${settings.prefix}xp add @user <amount> [chat|voice]\`\n\`${settings.prefix}xp remove @user <amount> [chat|voice]\`\n\`${settings.prefix}xp set @user <amount> [chat|voice]\`\n\`${settings.prefix}xp reset @user [chat|voice|all]\``);
  }
  const member = await resolveMember(message, args[1]);
  if (!member) return replyCard(message, 'Member not found', 'Mention a server member or provide their user ID.');
  if (member.user.bot) return replyCard(message, 'Bot account', 'XP changes for bot accounts are not supported.');

  if (action === 'reset') {
    const scope = String(args[2] || 'all').toLowerCase();
    if (!['chat', 'voice', 'all'].includes(scope)) return replyCard(message, 'Invalid scope', 'Choose `chat`, `voice`, or `all`.');
    await resetUserXp({ member, scope });
    addAudit(message.guild.id, message.author.id, 'xp_reset', member.id, scope);
    return replyCard(message, 'XP reset', `Reset **${scope} XP** for <@${member.id}>.`, 0x57F287);
  }

  const amount = Number.parseInt(args[2], 10);
  const scope = String(args[3] || 'chat').toLowerCase();
  if (!Number.isInteger(amount) || amount < 0 || amount > 100000000 || !validateScope(scope)) {
    return replyCard(message, 'Invalid amount or scope', 'Enter an amount from 0 to 100,000,000 and choose `chat` or `voice`.');
  }
  let result;
  if (action === 'add') {
    result = await grantXp({ member, amount, scope, reason: 'admin add' });
  } else if (action === 'remove') {
    const current = getUser(message.guild.id, member.id);
    const existing = scope === 'chat' ? current.chat_xp : current.voice_xp;
    result = await setUserXp({ member, amount: Math.max(0, existing - amount), scope });
  } else {
    result = await setUserXp({ member, amount, scope });
  }
  addAudit(message.guild.id, message.author.id, `xp_${action}`, member.id, `${scope}/${amount}`);
  const updated = getUser(message.guild.id, member.id);
  return replyCard(message, `XP ${action} complete`, `<@${member.id}> now has **${updated.chat_xp.toLocaleString()} chat XP** and **${updated.voice_xp.toLocaleString()} voice XP** (**${(updated.chat_xp + updated.voice_xp).toLocaleString()} combined**).`, 0x57F287);
}

async function commandDiagnostics(message) {
  if (!(await requireAdmin(message))) return;
  const guild = message.guild;
  const settings = getSettings(guild.id);
  const botMember = guild.members.me;
  const checks = [];
  const currentPerms = message.channel.permissionsFor(botMember);
  checks.push(`${currentPerms?.has(PermissionFlagsBits.ViewChannel) ? '✅' : '❌'} View current channel`);
  checks.push(`${currentPerms?.has(PermissionFlagsBits.SendMessages) ? '✅' : '❌'} Send messages in current channel`);
  checks.push(`${currentPerms?.has(PermissionFlagsBits.ReadMessageHistory) ? '✅' : '❌'} Read message history`);
  checks.push(`${botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ? '✅' : '⚠️'} Manage Roles (needed for role rewards)`);

  for (const scope of ['chat', 'voice']) {
    for (const kind of ['channel', 'role']) {
      const mode = getFilterMode(guild.id, scope, kind);
      const entryCount = getFilterEntries(guild.id, scope, kind).length;
      if (mode === 'whitelist' && entryCount === 0) checks.push(`⚠️ ${scope} ${kind} whitelist is empty; nobody will qualify via this filter.`);
    }
  }
  if (settings.levelup_channel_id) {
    const target = await guild.channels.fetch(settings.levelup_channel_id).catch(() => null);
    if (!target) checks.push('⚠️ Configured level-up channel no longer exists.');
    else {
      const perms = target.permissionsFor(botMember);
      checks.push(`${perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages) ? '✅' : '❌'} Send level-up messages in <#${target.id}>`);
    }
  } else {
    checks.push('ℹ️ No fixed level-up channel configured; automatic/system fallback is used.');
  }
  if (settings.voice_enabled) checks.push('ℹ️ Voice XP requires at least two human members in the channel and stops in the AFK channel or while deafened.');
  if (!settings.chat_enabled) checks.push('ℹ️ Chat XP is currently disabled.');
  return replyCard(message, 'Diagnostics', checks.join('\n'), checks.some(line => line.startsWith('❌')) ? 0xED4245 : 0x57F287);
}


async function commandResetAllXp(message, args) {
  if (!(await requireAdmin(message))) return;
  const confirmation = String(args[0] || '').toLowerCase();
  if (confirmation !== 'confirm') {
    return replyCard(message, 'Confirm server-wide XP reset', `This will reset **all chat and voice XP for every tracked member in this server**. This cannot be undone.\n\nTo proceed, run \`${getSettings(message.guild.id).prefix}resetallxp confirm\`.`, 0xED4245);
  }
  const affectedUsers = resetGuildXp(message.guild.id);
  addAudit(message.guild.id, message.author.id, 'xp_reset_all', null, `affected_users=${affectedUsers}`);
  return replyCard(message, 'Server XP reset complete', `Reset chat and voice XP for **${affectedUsers} member record(s)** in this server. Server settings, filters, rewards, and other servers were not changed.`, 0x57F287);
}

async function executePrefixCommand(message, prefix) {
  const input = message.content.slice(prefix.length).trim();
  if (!input) return;
  const args = input.split(/\s+/);
  const command = args.shift().toLowerCase();
  try {
    switch (command) {
      case 'ping':
        return replyCard(message, 'Pong!', `Prefix-command handler is responding. Gateway latency: **${Math.round(client.ws.ping)} ms**\nConnected servers: **${client.guilds.cache.size}**.`, 0x57F287);
      case 'help':
      case 'commands':
        return componentMessage(message.channel, buildHelpCard(prefix, false));
      case 'rank':
      case 'profile':
        return commandRank(message, args);
      case 'leaderboard':
      case 'lb':
        return commandLeaderboard(message, args);
      case 'prefix':
        return commandPrefix(message, args);
      case 'settings':
        return commandSettings(message);
      case 'chatxp':
        return commandChatXp(message, args);
      case 'voicexp':
        return commandVoiceXp(message, args);
      case 'levelup':
        return commandLevelUp(message, args);
      case 'filter':
        return commandFilter(message, args);
      case 'multiplier':
        return commandMultipliers(message, args);
      case 'rewards':
        return commandRewards(message, args);
      case 'xp':
        return commandXpAdmin(message, args);
      case 'resetallxp':
        return commandResetAllXp(message, args);
      case 'diag':
      case 'diagnostics':
        return commandDiagnostics(message);
      default:
        return replyCard(message, 'Unknown command', `I do not recognize \`${command}\`. Use \`${prefix}help\` to view commands.`);
    }
  } catch (error) {
    console.error(`[command:${command}]`, error);
    return replyCard(message, 'Command error', 'That command failed unexpectedly. Check the bot logs for details.');
  }
}

function claimChatCooldown(guildId, userId, cooldownSeconds) {
  ensureUser(guildId, userId);
  const now = Date.now();
  const row = db.prepare('SELECT last_chat_xp_at FROM users WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (row.last_chat_xp_at && now - row.last_chat_xp_at < cooldownSeconds * 1000) return false;
  db.prepare('UPDATE users SET last_chat_xp_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?').run(now, now, guildId, userId);
  return true;
}

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot || message.webhookId || !message.member) return;
  const settings = getSettings(message.guild.id);
  const prefix = settings.prefix || '!';
  if (message.content.startsWith(prefix)) {
    await executePrefixCommand(message, prefix);
    return; // Commands never earn XP.
  }
  if (!settings.chat_enabled) return;
  const content = (message.content || '').trim();
  if (content.length < settings.min_message_length) return;
  const eligibility = isXpAllowed(message.member, 'chat', message.channelId);
  if (!eligibility.allowed) return;
  if (!claimChatCooldown(message.guild.id, message.author.id, settings.chat_cooldown_seconds)) return;

  const base = randomInteger(settings.chat_xp_min, settings.chat_xp_max);
  const multiplier = getXpMultiplier(message.guild.id, message.member, message.channelId);
  const amount = Math.max(1, Math.round(base * multiplier));
  await grantXp({ member: message.member, amount, scope: 'chat', sourceChannel: message.channel, reason: 'message' }).catch(error => {
    console.error('[chat-xp]', error);
  });
});

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function updateVoiceSession(state) {
  const member = state.member;
  if (!member || member.user.bot) return;
  const key = sessionKey(state.guild.id, member.id);
  if (!state.channelId) {
    voiceSessions.delete(key);
    return;
  }
  voiceSessions.set(key, { lastAwardAt: Date.now(), channelId: state.channelId });
}

client.on(Events.VoiceStateUpdate, (_oldState, newState) => {
  updateVoiceSession(newState);
});

async function voiceXpTick() {
  if (voiceTickRunning || !client.isReady()) return;
  voiceTickRunning = true;
  try {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      const settings = getSettings(guild.id);
      if (!settings.voice_enabled) continue;
      for (const voiceState of guild.voiceStates.cache.values()) {
        const channel = voiceState.channel;
        const member = voiceState.member;
        if (!channel || !member || member.user.bot) continue;
        const key = sessionKey(guild.id, member.id);
        let session = voiceSessions.get(key);
        if (!session || session.channelId !== channel.id) {
          session = { lastAwardAt: now, channelId: channel.id };
          voiceSessions.set(key, session);
          continue;
        }
        const humans = channel.members.filter(channelMember => !channelMember.user.bot).size;
        const deafened = voiceState.selfDeaf || voiceState.serverDeaf;
        const isAfk = guild.afkChannelId && guild.afkChannelId === channel.id;
        const eligibility = isXpAllowed(member, 'voice', channel.id);
        const intervalMs = Math.max(30, settings.voice_interval_seconds) * 1000;
        if (humans < 2 || deafened || isAfk || !eligibility.allowed) {
          // Reset the timer so an ineligible period is never banked as XP.
          session.lastAwardAt = now;
          continue;
        }
        if (now - session.lastAwardAt < intervalMs) continue;
        session.lastAwardAt = now;
        const base = randomInteger(settings.voice_xp_min, settings.voice_xp_max);
        const multiplier = getXpMultiplier(guild.id, member, channel.id);
        const amount = Math.max(1, Math.round(base * multiplier));
        await grantXp({ member, amount, scope: 'voice', sourceChannel: null, reason: 'voice interval' }).catch(error => {
          console.error('[voice-xp]', error);
        });
      }
    }
    // Remove sessions for users no longer present in cached voice states.
    const activeKeys = new Set();
    for (const guild of client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        if (state.channelId && state.member && !state.member.user.bot) activeKeys.add(sessionKey(guild.id, state.id));
      }
    }
    for (const key of voiceSessions.keys()) if (!activeKeys.has(key)) voiceSessions.delete(key);
  } catch (error) {
    console.error('[voice-tick]', error);
  } finally {
    voiceTickRunning = false;
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isModalSubmit?.() && interaction.customId.startsWith('xpbot:modal:')) {
    try {
      if (!interaction.guild) {
        await interaction.reply({ content: 'This form must be submitted inside a server.', ephemeral: true });
        return;
      }
      if (!(await requireComponentAdmin(interaction))) return;
      const parts = interaction.customId.split(':');
      const modalAction = parts[2];
      const panelId = parts[3] || null;
      const guild = interaction.guild;
      let panel = 'settings';
      let state = {};

      if (modalAction === 'levelup-message') {
        const template = interaction.fields.getTextInputValue('template').trim();
        if (!template || template.length > 1500) {
          await interaction.reply({ content: 'Enter a level-up message between 1 and 1500 characters.', ephemeral: true });
          return;
        }
        setSetting(guild.id, 'levelup_message', template);
        addAudit(guild.id, interaction.user.id, 'levelup_message', null, template);
        panel = 'levelup';
        await replyWithInteractivePanel(interaction, panel, buildLevelUpPanel(guild));
        return;
      }

      if (modalAction === 'chatxp-range') {
        const min = Number.parseInt(interaction.fields.getTextInputValue('min'), 10);
        const max = Number.parseInt(interaction.fields.getTextInputValue('max'), 10);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 1000) {
          await interaction.reply({ content: 'Choose a minimum of 1–1000 and a maximum greater than or equal to the minimum (up to 1000).', ephemeral: true });
          return;
        }
        setSetting(guild.id, 'chat_xp_min', min);
        setSetting(guild.id, 'chat_xp_max', max);
        addAudit(guild.id, interaction.user.id, 'chat_xp_range', null, `${min}-${max}`);
        await replyWithInteractivePanel(interaction, 'chatxp', buildChatXpPanel(guild));
        return;
      }
      if (modalAction === 'chatxp-cooldown') {
        const seconds = Number.parseInt(interaction.fields.getTextInputValue('seconds'), 10);
        if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) {
          await interaction.reply({ content: 'Cooldown must be between 5 and 3600 seconds.', ephemeral: true });
          return;
        }
        setSetting(guild.id, 'chat_cooldown_seconds', seconds);
        addAudit(guild.id, interaction.user.id, 'chat_xp_cooldown', null, seconds);
        await replyWithInteractivePanel(interaction, 'chatxp', buildChatXpPanel(guild));
        return;
      }
      if (modalAction === 'chatxp-minlength') {
        const length = Number.parseInt(interaction.fields.getTextInputValue('characters'), 10);
        if (!Number.isInteger(length) || length < 1 || length > 500) {
          await interaction.reply({ content: 'Minimum message length must be between 1 and 500 characters.', ephemeral: true });
          return;
        }
        setSetting(guild.id, 'min_message_length', length);
        addAudit(guild.id, interaction.user.id, 'chat_xp_minlength', null, length);
        await replyWithInteractivePanel(interaction, 'chatxp', buildChatXpPanel(guild));
        return;
      }
      if (modalAction === 'voicexp-range') {
        const min = Number.parseInt(interaction.fields.getTextInputValue('min'), 10);
        const max = Number.parseInt(interaction.fields.getTextInputValue('max'), 10);
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 1000) {
          await interaction.reply({ content: 'Choose a minimum of 1–1000 and a maximum greater than or equal to the minimum (up to 1000).', ephemeral: true });
          return;
        }
        setSetting(guild.id, 'voice_xp_min', min);
        setSetting(guild.id, 'voice_xp_max', max);
        addAudit(guild.id, interaction.user.id, 'voice_xp_range', null, `${min}-${max}`);
        await replyWithInteractivePanel(interaction, 'voicexp', buildVoiceXpPanel(guild));
        return;
      }
      if (modalAction === 'voicexp-interval') {
        const seconds = Number.parseInt(interaction.fields.getTextInputValue('seconds'), 10);
        if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
          await interaction.reply({ content: 'Voice XP interval must be between 30 and 3600 seconds.', ephemeral: true });
          return;
        }
        setSetting(guild.id, 'voice_interval_seconds', seconds);
        addAudit(guild.id, interaction.user.id, 'voice_xp_interval', null, seconds);
        await replyWithInteractivePanel(interaction, 'voicexp', buildVoiceXpPanel(guild));
        return;
      }
      if (modalAction === 'multiplier-value') {
        panel = 'multipliers';
        state = { ...(uiSessions.get(panelId) || {}), panel: 'multipliers' };
        const targetType = state.targetType === 'role' ? 'role' : 'channel';
        if (!state.targetId) {
          await interaction.reply({ content: 'Open the multiplier panel, select a channel or role, then choose Set / update value.', ephemeral: true });
          return;
        }
        const value = Number.parseFloat(interaction.fields.getTextInputValue('value'));
        if (!Number.isFinite(value) || value < 0.1 || value > 5) {
          await interaction.reply({ content: 'The multiplier must be between 0.1 and 5.', ephemeral: true });
          return;
        }
        db.prepare(`INSERT INTO xp_multipliers (guild_id, target_type, target_id, multiplier, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(guild_id, target_type, target_id) DO UPDATE SET multiplier = excluded.multiplier, updated_at = excluded.updated_at`)
          .run(guild.id, targetType, state.targetId, value, Date.now());
        addAudit(guild.id, interaction.user.id, 'multiplier_set', state.targetId, `${targetType}/${value}`);
        state.notice = `Saved ×${value} for ${targetType} ${state.targetLabel || state.targetId}.`;
        await replyWithInteractivePanel(interaction, panel, buildMultiplierPanel(guild, state), { targetType, targetId: state.targetId, targetLabel: state.targetLabel, notice: state.notice });
        return;
      }
      if (modalAction === 'reward-level') {
        panel = 'rewards';
        state = { ...(uiSessions.get(panelId) || {}), panel: 'rewards' };
        const roleId = state.roleId;
        if (!roleId) {
          await interaction.reply({ content: 'Open the rewards panel and select a role first.', ephemeral: true });
          return;
        }
        const level = Number.parseInt(interaction.fields.getTextInputValue('level'), 10);
        if (!Number.isInteger(level) || level < 1 || level > 10000) {
          await interaction.reply({ content: 'Reward level must be an integer between 1 and 10000.', ephemeral: true });
          return;
        }
        const role = await guild.roles.fetch(roleId).catch(() => null);
        const botMember = guild.members.me;
        if (!role) {
          await interaction.reply({ content: 'That role no longer exists. Select another role.', ephemeral: true });
          return;
        }
        if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || role.managed || role.position >= botMember.roles.highest.position) {
          await interaction.reply({ content: 'I need Manage Roles, and my highest role must be above the selected reward role.', ephemeral: true });
          return;
        }
        db.prepare('INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id').run(guild.id, level, role.id);
        addAudit(guild.id, interaction.user.id, 'reward_set', role.id, level);
        state.level = String(level);
        state.notice = `Saved ${role.name} for level ${level}.`;
        await replyWithInteractivePanel(interaction, panel, buildRewardsPanel(guild, state), { roleId: state.roleId, level: state.level, notice: state.notice });
        return;
      }
      await interaction.reply({ content: 'Unknown settings form. Please reopen the relevant settings panel and try again.', ephemeral: true });
    } catch (error) {
      console.error(`[modal:${interaction.customId}]`, error);
      const payload = { content: 'That settings form failed. Check the bot service logs for details.', ephemeral: true };
      if (!interaction.replied && !interaction.deferred) await interaction.reply(payload).catch(() => {});
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    try {
      await handleSlashCommand(interaction, client);
    } catch (error) {
      console.error(`[slash:${interaction.commandName}] ${error?.stack || error}`);
      const messageText = 'That slash command failed. The error has been logged; ask an administrator to check the bot service logs.';
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: messageText, ephemeral: true }).catch(replyError => console.error('[slash error reply]', replyError));
      } else {
        await interaction.followUp({ content: messageText, ephemeral: true }).catch(replyError => console.error('[slash error follow-up]', replyError));
      }
    }
    return;
  }
  if (!interaction.isMessageComponent() || !interaction.customId.startsWith('xpbot:') || !interaction.guild) return;

  try {
    const parts = interaction.customId.split(':');
    if (parts[1] === 'lb') {
      const scope = ['all', 'chat', 'voice'].includes(parts[2]) ? parts[2] : 'all';
      const page = Math.max(1, Number.parseInt(parts[3] || '1', 10) || 1);
      await interaction.update({ components: buildLeaderboardCard(interaction.guild, scope, page), allowedMentions: { parse: [] } });
      return;
    }

    if (parts[1] === 'nav') {
      if (!(await requireComponentAdmin(interaction))) return;
      const target = parts[2];
      const guild = interaction.guild;
      switch (target) {
        case 'settings':
          await updateInteractivePanel(interaction, 'settings', buildSettingsPanel(guild));
          return;
        case 'chatxp':
          await updateInteractivePanel(interaction, 'chatxp', buildChatXpPanel(guild));
          return;
        case 'voicexp':
          await updateInteractivePanel(interaction, 'voicexp', buildVoiceXpPanel(guild));
          return;
        case 'levelup':
          await updateInteractivePanel(interaction, 'levelup', buildLevelUpPanel(guild));
          return;
        case 'filters':
          await updateInteractivePanel(interaction, 'filter', buildFilterPanel(guild), { kind: 'channel', scope: 'chat', targetId: null, targetLabel: null, notice: '' });
          return;
        case 'multipliers':
          await updateInteractivePanel(interaction, 'multipliers', buildMultiplierPanel(guild), { targetType: 'channel', targetId: null, targetLabel: null, notice: '' });
          return;
        case 'rewards':
          await updateInteractivePanel(interaction, 'rewards', buildRewardsPanel(guild), { roleId: null, level: null, notice: '' });
          return;
        case 'help':
          await updateInteractivePanel(interaction, 'help', buildHelpCard(getSettings(guild.id).prefix, canManageInteraction(interaction))); 
          return;
      }
    }

    if (parts[1] === 'settings') {
      if (!(await requireComponentAdmin(interaction))) return;
      const key = parts[2];
      const settings = getSettings(interaction.guild.id);
      const map = { chat: 'chat_enabled', voice: 'voice_enabled', levelup: 'levelup_enabled' };
      if (!map[key]) {
        await interaction.reply({ content: 'Unknown settings control.', ephemeral: true }).catch(() => {});
        return;
      }
      const enabled = settings[map[key]] ? 0 : 1;
      setSetting(interaction.guild.id, map[key], enabled);
      addAudit(interaction.guild.id, interaction.user.id, 'settings_panel_toggle', null, key);
      await interaction.update({ components: buildSettingsPanel(interaction.guild), allowedMentions: { parse: [] } });
      return;
    }

    if (['chatxp', 'voicexp'].includes(parts[1])) {
      if (!(await requireComponentAdmin(interaction))) return;
      const guild = interaction.guild;
      const chat = parts[1] === 'chatxp';
      const action = parts[2];
      const settingKey = chat ? 'chat_enabled' : 'voice_enabled';
      const panel = chat ? 'chatxp' : 'voicexp';
      if (action === 'toggle') {
        const updated = getSettings(guild.id)[settingKey] ? 0 : 1;
        setSetting(guild.id, settingKey, updated);
        addAudit(guild.id, interaction.user.id, `${panel}_toggle`, null, Boolean(updated));
        await updateInteractivePanel(interaction, panel, chat ? buildChatXpPanel(guild) : buildVoiceXpPanel(guild));
        return;
      }
      const panelId = interaction.message.id;
      if (chat && action === 'range') {
        const settings = getSettings(guild.id);
        await showInputModal(interaction, `xpbot:modal:chatxp-range:${panelId}`, 'Set chat XP range', [
          modalField('min', 'Minimum XP', { value: settings.chat_xp_min, maxLength: 4 }),
          modalField('max', 'Maximum XP', { value: settings.chat_xp_max, maxLength: 4 })
        ]);
        return;
      }
      if (chat && action === 'cooldown') {
        await showInputModal(interaction, `xpbot:modal:chatxp-cooldown:${panelId}`, 'Set chat XP cooldown', [modalField('seconds', 'Cooldown in seconds', { value: getSettings(guild.id).chat_cooldown_seconds, maxLength: 4 })]);
        return;
      }
      if (chat && action === 'minlength') {
        await showInputModal(interaction, `xpbot:modal:chatxp-minlength:${panelId}`, 'Set minimum message length', [modalField('characters', 'Minimum non-space characters', { value: getSettings(guild.id).min_message_length, maxLength: 3 })]);
        return;
      }
      if (!chat && action === 'range') {
        const settings = getSettings(guild.id);
        await showInputModal(interaction, `xpbot:modal:voicexp-range:${panelId}`, 'Set voice XP range', [
          modalField('min', 'Minimum XP', { value: settings.voice_xp_min, maxLength: 4 }),
          modalField('max', 'Maximum XP', { value: settings.voice_xp_max, maxLength: 4 })
        ]);
        return;
      }
      if (!chat && action === 'interval') {
        await showInputModal(interaction, `xpbot:modal:voicexp-interval:${panelId}`, 'Set voice XP interval', [modalField('seconds', 'Interval in seconds', { value: getSettings(guild.id).voice_interval_seconds, maxLength: 4 })]);
        return;
      }
    }

    if (parts[1] === 'levelup') {
      if (!(await requireComponentAdmin(interaction))) return;
      const guild = interaction.guild;
      const action = parts[2];
      if (action === 'toggle') {
        const enabled = getSettings(guild.id).levelup_enabled ? 0 : 1;
        setSetting(guild.id, 'levelup_enabled', enabled);
        addAudit(guild.id, interaction.user.id, 'levelup_toggle', null, Boolean(enabled));
        await updateInteractivePanel(interaction, 'levelup', buildLevelUpPanel(guild));
        return;
      }
      if (action === 'edit-message') {
        const template = getSettings(guild.id).levelup_message || '{user} reached Level {level} in {server}!';
        await showInputModal(interaction, 'xpbot:modal:levelup-message', 'Edit level-up message', [modalField('template', 'Message template', { paragraph: true, maxLength: 1500, value: template, placeholder: 'Use {user}, {level}, {server}, and {xp}' })]);
        return;
      }
      if (action === 'mode' && interaction.isStringSelectMenu()) {
        const mode = interaction.values[0];
        if (!['auto', 'current', 'system', 'dm'].includes(mode)) {
          await interaction.reply({ content: 'Invalid level-up mode.', ephemeral: true });
          return;
        }
        setSetting(guild.id, 'levelup_mode', mode);
        setSetting(guild.id, 'levelup_channel_id', null);
        addAudit(guild.id, interaction.user.id, 'levelup_destination', null, mode);
        await updateInteractivePanel(interaction, 'levelup', buildLevelUpPanel(guild));
        return;
      }
      if (action === 'channel' && interaction.isChannelSelectMenu()) {
        const channel = await guild.channels.fetch(interaction.values[0]).catch(() => null);
        if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
          await interaction.reply({ content: 'Please select a sendable text channel.', ephemeral: true });
          return;
        }
        const permissions = guild.members.me?.permissionsIn(channel);
        if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
          await interaction.reply({ content: `I need View Channel and Send Messages in #${channel.name}.`, ephemeral: true });
          return;
        }
        setSetting(guild.id, 'levelup_mode', 'channel');
        setSetting(guild.id, 'levelup_channel_id', channel.id);
        addAudit(guild.id, interaction.user.id, 'levelup_destination', channel.id, 'interactive_panel');
        await updateInteractivePanel(interaction, 'levelup', buildLevelUpPanel(guild));
        return;
      }
    }

    if (parts[1] === 'filter') {
      if (!(await requireComponentAdmin(interaction))) return;
      const guild = interaction.guild;
      const state = currentUiSession(interaction, 'filter', { kind: 'channel', scope: 'chat', targetId: null, targetLabel: null, notice: '' });
      state.panel = 'filter';
      const action = parts[2];
      if (action === 'kind' && interaction.isStringSelectMenu()) {
        state.kind = interaction.values[0];
        if (state.kind !== 'member' && state.scope === 'all') state.scope = 'chat';
        state.targetId = null; state.targetLabel = null; state.notice = '';
      } else if (action === 'scope' && interaction.isStringSelectMenu()) {
        state.scope = interaction.values[0];
        state.targetId = null; state.targetLabel = null; state.notice = '';
      } else if (action === 'mode' && interaction.isStringSelectMenu()) {
        const mode = interaction.values[0];
        if (!['whitelist', 'blacklist'].includes(mode) || state.kind === 'member') {
          await interaction.reply({ content: 'Choose a valid filter mode for channels or roles.', ephemeral: true });
          return;
        }
        setFilterMode(guild.id, state.scope, state.kind, mode);
        addAudit(guild.id, interaction.user.id, 'filter_mode_set', null, `${state.kind}/${state.scope}/${mode}`);
        state.notice = `Changed ${state.kind} ${state.scope} mode to ${mode}.`;
      } else if (action === 'target-channel' && interaction.isChannelSelectMenu()) {
        state.targetId = interaction.values[0];
        const ch = guild.channels.cache.get(state.targetId);
        state.targetLabel = ch ? `#${ch.name}` : state.targetId;
        state.notice = 'Channel selected; choose Add selected or Remove selected.';
      } else if (action === 'target-role' && interaction.isRoleSelectMenu()) {
        state.targetId = interaction.values[0];
        const role = guild.roles.cache.get(state.targetId);
        state.targetLabel = role ? `@${role.name}` : state.targetId;
        state.notice = 'Role selected; choose Add selected or Remove selected.';
      } else if (action === 'target-user' && interaction.isUserSelectMenu()) {
        state.targetId = interaction.values[0];
        const user = await client.users.fetch(state.targetId).catch(() => null);
        state.targetLabel = user?.username || state.targetId;
        state.notice = 'Member selected; choose Exclude member or Include member.';
      } else if (action === 'list') {
        state.notice = 'List refreshed.';
      } else if (action === 'add' || action === 'remove') {
        if (state.kind === 'member') {
          await interaction.reply({ content: 'For members, use Exclude member or Include member.', ephemeral: true });
          return;
        }
        if (!state.targetId) {
          await interaction.reply({ content: 'Select a channel or role from the target dropdown first.', ephemeral: true });
          return;
        }
        const changed = action === 'add'
          ? addFilterEntry(guild.id, state.scope, state.kind, state.targetId)
          : removeFilterEntry(guild.id, state.scope, state.kind, state.targetId);
        addAudit(guild.id, interaction.user.id, `filter_${action}`, state.targetId, `${state.kind}/${state.scope}`);
        state.notice = `${state.targetLabel || state.targetId} ${changed ? (action === 'add' ? 'added to' : 'removed from') : (action === 'add' ? 'was already in' : 'was not in')} the ${getFilterMode(guild.id, state.scope, state.kind)} list.`;
      } else if (action === 'exclude' || action === 'include') {
        if (state.kind !== 'member' || !state.targetId) {
          await interaction.reply({ content: 'Choose Member as the filter type, then select a member first.', ephemeral: true });
          return;
        }
        setMemberExcluded(guild.id, state.targetId, state.scope, action === 'exclude');
        addAudit(guild.id, interaction.user.id, `member_filter_${action}`, state.targetId, state.scope);
        state.notice = `${state.targetLabel || `<@${state.targetId}>`} ${action === 'exclude' ? 'excluded from' : 'included for'} ${state.scope} XP.`;
      }
      await updateInteractivePanel(interaction, 'filter', buildFilterPanel(guild, state), state);
      return;
    }

    if (parts[1] === 'multiplier') {
      if (!(await requireComponentAdmin(interaction))) return;
      const guild = interaction.guild;
      const state = currentUiSession(interaction, 'multipliers', { targetType: 'channel', targetId: null, targetLabel: null, notice: '' });
      state.panel = 'multipliers';
      const action = parts[2];
      if (action === 'type' && interaction.isStringSelectMenu()) {
        state.targetType = interaction.values[0] === 'role' ? 'role' : 'channel';
        state.targetId = null; state.targetLabel = null; state.notice = '';
      } else if (action === 'target-channel' && interaction.isChannelSelectMenu()) {
        state.targetType = 'channel'; state.targetId = interaction.values[0];
        const channel = guild.channels.cache.get(state.targetId);
        state.targetLabel = channel ? `#${channel.name}` : state.targetId;
        state.notice = 'Target channel selected.';
      } else if (action === 'target-role' && interaction.isRoleSelectMenu()) {
        state.targetType = 'role'; state.targetId = interaction.values[0];
        const role = guild.roles.cache.get(state.targetId);
        state.targetLabel = role ? `@${role.name}` : state.targetId;
        state.notice = 'Target role selected.';
      } else if (action === 'toggle') {
        const enabled = getSettings(guild.id).multipliers_enabled ? 0 : 1;
        setSetting(guild.id, 'multipliers_enabled', enabled);
        addAudit(guild.id, interaction.user.id, 'multipliers_toggle', null, Boolean(enabled));
        state.notice = `Multiplier system ${enabled ? 'enabled' : 'disabled'}.`;
      } else if (action === 'set') {
        if (!state.targetId) {
          await interaction.reply({ content: 'Select a channel or role first.', ephemeral: true });
          return;
        }
        await showInputModal(interaction, `xpbot:modal:multiplier-value:${interaction.message.id}`, 'Set XP multiplier', [modalField('value', 'Multiplier (0.1–5)', { maxLength: 4, placeholder: '1.5' })]);
        return;
      } else if (action === 'remove') {
        if (!state.targetId) {
          await interaction.reply({ content: 'Select a channel or role first.', ephemeral: true });
          return;
        }
        const result = db.prepare('DELETE FROM xp_multipliers WHERE guild_id = ? AND target_type = ? AND target_id = ?').run(guild.id, state.targetType, state.targetId);
        addAudit(guild.id, interaction.user.id, 'multiplier_remove', state.targetId, state.targetType);
        state.notice = result.changes ? `Removed multiplier for ${state.targetLabel || state.targetId}.` : 'No multiplier was set for that target.';
      } else if (action === 'list') {
        state.notice = 'Multiplier list refreshed.';
      }
      await updateInteractivePanel(interaction, 'multipliers', buildMultiplierPanel(guild, state), state);
      return;
    }

    if (parts[1] === 'rewards') {
      if (!(await requireComponentAdmin(interaction))) return;
      const guild = interaction.guild;
      const state = currentUiSession(interaction, 'rewards', { roleId: null, level: null, notice: '' });
      state.panel = 'rewards';
      const action = parts[2];
      if (action === 'role' && interaction.isRoleSelectMenu()) {
        state.roleId = interaction.values[0];
        state.notice = `Selected ${guild.roles.cache.get(state.roleId)?.name || state.roleId}.`;
      } else if (action === 'level' && interaction.isStringSelectMenu()) {
        state.level = interaction.values[0] === 'none' ? null : interaction.values[0];
        state.notice = state.level ? `Selected level ${state.level}.` : 'No reward level selected.';
      } else if (action === 'set') {
        if (!state.roleId) {
          await interaction.reply({ content: 'Select a role first, then choose Add / update reward.', ephemeral: true });
          return;
        }
        await showInputModal(interaction, `xpbot:modal:reward-level:${interaction.message.id}`, 'Set level reward', [modalField('level', 'Level to grant the selected role', { maxLength: 5, placeholder: '10' })]);
        return;
      } else if (action === 'remove') {
        const level = Number.parseInt(state.level, 10);
        if (!Number.isInteger(level) || level < 1) {
          await interaction.reply({ content: 'Select an existing reward level first.', ephemeral: true });
          return;
        }
        const result = db.prepare('DELETE FROM level_rewards WHERE guild_id = ? AND level = ?').run(guild.id, level);
        addAudit(guild.id, interaction.user.id, 'reward_remove', null, level);
        state.level = null;
        state.notice = result.changes ? `Removed the reward at level ${level}.` : `No reward existed at level ${level}.`;
      } else if (action === 'list') {
        state.notice = 'Reward list refreshed.';
      }
      await updateInteractivePanel(interaction, 'rewards', buildRewardsPanel(guild, state), state);
      return;
    }
  } catch (error) {
    console.error(`[component:${interaction.customId}] ${error?.stack || error}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'That interactive setting failed. Check the bot service logs, then reopen the panel using the prefix command.', ephemeral: true }).catch(() => {});
    }
  }
});
client.once(Events.ClientReady, readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Serving ${readyClient.guilds.cache.size} server(s).`);
  for (const guild of readyClient.guilds.cache.values()) {
    getSettings(guild.id);
    for (const voiceState of guild.voiceStates.cache.values()) updateVoiceSession(voiceState);
  }
  setInterval(() => void voiceXpTick(), 15_000).unref();
});

client.on(Events.GuildCreate, guild => {
  getSettings(guild.id);
  console.log(`Joined server: ${guild.name} (${guild.id})`);
});

client.on(Events.Error, error => console.error('[discord client error]', error));
process.on('unhandledRejection', reason => console.error('[unhandled rejection]', reason));
process.on('uncaughtException', error => {
  console.error('[uncaught exception]', error);
  // Fatal uncaught exceptions can leave the process in an unsafe state. Let a process manager restart it.
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('Could not log in to Discord. Check DISCORD_TOKEN and the Developer Portal configuration.');
  console.error(error.message);
  process.exit(1);
});

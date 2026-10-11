import { db, getSettings, getUser, getLeaderboard, getLeaderboardCount, getUserRank, getFilterMode, getFilterEntries } from './database.js';
import { getLevel, xpForLevel } from './xpMath.js';

export const COMPONENTS_V2_FLAG = 1 << 15;

export const textDisplay = content => ({ type: 10, content: String(content) });
export const separator = (spacing = 1, divider = true) => ({ type: 14, spacing, divider });
export const actionRow = components => ({ type: 1, components });
export const button = (label, customId, style = 2, disabled = false) => ({
  type: 2, style, label, custom_id: customId, disabled
});
export const container = (components, accentColor = 0x5865F2) => ({
  type: 17, accent_color: accentColor, components
});
export const sectionWithThumbnail = (content, url, description = 'User avatar') => ({
  type: 9,
  components: [textDisplay(content)],
  accessory: { type: 11, media: { url }, description }
});

export async function sendV2(channel, children, options = {}) {
  if (!channel?.isTextBased?.() || !channel.send) throw new Error('The target is not a sendable text channel.');
  return channel.send({
    flags: COMPONENTS_V2_FLAG,
    components: [container(children, options.accentColor ?? 0x5865F2)],
    allowedMentions: options.allowedMentions ?? { parse: [] }
  });
}

const safeName = user => (user.globalName || user.username || 'Member').replace(/[`]/g, 'ˋ').slice(0, 70);
const progressBar = (done, total, width = 12) => {
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const filled = Math.round(ratio * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
};

export async function buildRankCard(guild, user) {
  const record = getUser(guild.id, user.id);
  const allXp = record.chat_xp + record.voice_xp;
  const level = getLevel(allXp);
  const currentFloor = xpForLevel(level);
  const nextFloor = xpForLevel(level + 1);
  const progress = allXp - currentFloor;
  const required = nextFloor - currentFloor;
  const allRank = getUserRank(guild.id, user.id, 'all');
  const chatRank = getUserRank(guild.id, user.id, 'chat');
  const voiceRank = getUserRank(guild.id, user.id, 'voice');
  const card = sectionWithThumbnail(
    `# ${safeName(user)}\n**Level ${level}** · Combined rank **#${allRank.position}**\n\n${progressBar(progress, required)} **${progress}/${required} XP** to Level ${level + 1}\n\n**Total XP:** ${allXp.toLocaleString()}\n**Chat XP:** ${record.chat_xp.toLocaleString()} · Rank #${chatRank.position}\n**Voice XP:** ${record.voice_xp.toLocaleString()} · Rank #${voiceRank.position}\n\n*XP is earned in eligible channels according to this server's settings.*`,
    user.displayAvatarURL({ extension: 'png', size: 128 }),
    `${safeName(user)} avatar`
  );
  return [card, separator(), actionRow([
    button('Combined leaderboard', 'xpbot:lb:all:1', 1),
    button('Chat leaderboard', 'xpbot:lb:chat:1', 2),
    button('Voice leaderboard', 'xpbot:lb:voice:1', 2)
  ])];
}

export function buildLeaderboardCard(guild, scope = 'all', page = 1) {
  const allowedScopes = new Set(['all', 'chat', 'voice']);
  if (!allowedScopes.has(scope)) scope = 'all';
  const limit = 10;
  const count = getLeaderboardCount(guild.id, scope);
  const totalPages = Math.max(1, Math.ceil(count / limit));
  const safePage = Math.max(1, Math.min(Number.isFinite(page) ? Math.floor(page) : 1, totalPages));
  const rows = getLeaderboard(guild.id, scope, limit, (safePage - 1) * limit);
  const label = scope === 'all' ? 'Combined XP' : scope === 'chat' ? 'Chat XP' : 'Voice XP';
  const lines = rows.map((row, i) => {
    const medal = (safePage - 1) * limit + i + 1;
    const total = row.xp.toLocaleString();
    const extra = scope === 'all' ? ` · Chat ${row.chat_xp.toLocaleString()} / Voice ${row.voice_xp.toLocaleString()}` : '';
    return `**${medal}.** <@${row.user_id}> — **${total} XP**${extra}`;
  });
  const body = lines.length ? lines.join('\n') : '*No XP recorded yet. Send eligible messages or join an eligible voice channel to get started.*';
  const children = [
    textDisplay(`# 🏆 ${guild.name.replace(/[`]/g, 'ˋ').slice(0, 70)} Leaderboard\n**${label}** · Page ${safePage}/${totalPages} · ${count} ranked member${count === 1 ? '' : 's'}`),
    separator(),
    textDisplay(body),
    separator(),
    actionRow([
      button('Combined', `xpbot:lb:all:${safePage}`, scope === 'all' ? 1 : 2),
      button('Chat', `xpbot:lb:chat:${safePage}`, scope === 'chat' ? 1 : 2),
      button('Voice', `xpbot:lb:voice:${safePage}`, scope === 'voice' ? 1 : 2),
      button('Previous', `xpbot:lb:${scope}:${safePage - 1}`, 2, safePage <= 1),
      button('Next', `xpbot:lb:${scope}:${safePage + 1}`, 2, safePage >= totalPages)
    ])
  ];
  return [container(children, 0xF1C40F)];
}

const stringSelect = (customId, placeholder, options) => ({
  type: 3,
  custom_id: customId,
  placeholder: String(placeholder).slice(0, 150),
  min_values: 1,
  max_values: 1,
  options: options.slice(0, 25)
});

const channelSelect = (customId, placeholder) => ({
  type: 8, custom_id: customId, placeholder: String(placeholder).slice(0, 150), min_values: 1, max_values: 1
});
const roleSelect = (customId, placeholder) => ({
  type: 6, custom_id: customId, placeholder: String(placeholder).slice(0, 150), min_values: 1, max_values: 1
});
const userSelect = (customId, placeholder) => ({
  type: 5, custom_id: customId, placeholder: String(placeholder).slice(0, 150), min_values: 1, max_values: 1
});
const option = (label, value, selected = false, description = undefined) => ({ label: String(label).slice(0, 100), value: String(value), default: Boolean(selected), ...(description ? { description: String(description).slice(0, 100) } : {}) });
const heading = text => textDisplay(`# ${text}`);
const safeGuildName = guild => String(guild.name || 'Server').replace(/[`]/g, 'ˋ').slice(0, 70);

export function buildSettingsPanel(guild) {
  const settings = getSettings(guild.id);
  const status = value => value ? '🟢 Enabled' : '🔴 Disabled';
  const destination = settings.levelup_channel_id ? `<#${settings.levelup_channel_id}>` : (settings.levelup_mode === 'auto' ? 'Automatic' : settings.levelup_mode);
  return [container([
    heading(`⚙️ ${safeGuildName(guild)} XP Settings`),
    textDisplay('Use the buttons and menus below to configure XP. Changes apply immediately and are restricted to members with **Manage Server**.'),
    separator(),
    textDisplay(`**Chat XP:** ${status(Boolean(settings.chat_enabled))}\nRange: ${settings.chat_xp_min}–${settings.chat_xp_max} XP · Cooldown: ${settings.chat_cooldown_seconds}s · Minimum message: ${settings.min_message_length} characters`),
    textDisplay(`**Voice XP:** ${status(Boolean(settings.voice_enabled))}\nRange: ${settings.voice_xp_min}–${settings.voice_xp_max} XP every ${settings.voice_interval_seconds}s`),
    textDisplay(`**Level-up notifications:** ${status(Boolean(settings.levelup_enabled))}\nDestination: ${destination}`),
    actionRow([
      button(`Chat XP: ${settings.chat_enabled ? 'ON' : 'OFF'}`, 'xpbot:settings:chat', settings.chat_enabled ? 3 : 2),
      button(`Voice XP: ${settings.voice_enabled ? 'ON' : 'OFF'}`, 'xpbot:settings:voice', settings.voice_enabled ? 3 : 2),
      button(`Level-up: ${settings.levelup_enabled ? 'ON' : 'OFF'}`, 'xpbot:settings:levelup', settings.levelup_enabled ? 3 : 2)
    ]),
    actionRow([
      button('Chat XP settings', 'xpbot:nav:chatxp'),
      button('Voice XP settings', 'xpbot:nav:voicexp'),
      button('Level-up settings', 'xpbot:nav:levelup'),
      button('Filters', 'xpbot:nav:filters'),
      button('Multipliers', 'xpbot:nav:multipliers')
    ]),
    actionRow([
      button('Level rewards', 'xpbot:nav:rewards'),
      button('Help / commands', 'xpbot:nav:help')
    ]),
    textDisplay(`Current prefix: \`${settings.prefix}\`. Prefix commands such as \`${settings.prefix}filter\`, \`${settings.prefix}chatxp\`, \`${settings.prefix}voicexp\`, \`${settings.prefix}multiplier\`, and \`${settings.prefix}rewards\` also open interactive panels when used without arguments.`)
  ], 0x5865F2)];
}

export function buildLevelUpPanel(guild) {
  const settings = getSettings(guild.id);
  const destination = settings.levelup_channel_id ? `<#${settings.levelup_channel_id}>` : (settings.levelup_mode === 'auto' ? 'Automatic' : settings.levelup_mode);
  const template = String(settings.levelup_message || '').slice(0, 1100);
  return [container([
    heading('🎉 Level-up notification settings'),
    textDisplay(`**Status:** ${settings.levelup_enabled ? '🟢 Enabled' : '🔴 Disabled'}\n**Destination mode:** ${settings.levelup_mode}\n**Destination:** ${destination}\n\n**Current message template**\n${template || '*No message set*'}\n\nPlaceholders: \`{user}\`, \`{level}\`, \`{server}\`, \`{xp}\`.`),
    separator(),
    actionRow([
      button(settings.levelup_enabled ? 'Disable notices' : 'Enable notices', 'xpbot:levelup:toggle', settings.levelup_enabled ? 4 : 3),
      button('Edit level-up message', 'xpbot:levelup:edit-message', 1),
      button('Back to Settings', 'xpbot:nav:settings', 2)
    ]),
    actionRow([stringSelect('xpbot:levelup:mode', 'Choose automatic, current channel, system channel, or DM', [
      option('Automatic', 'auto', settings.levelup_mode === 'auto', 'Smart default destination'),
      option('Current channel', 'current', settings.levelup_mode === 'current'),
      option('Server system channel', 'system', settings.levelup_mode === 'system'),
      option('Direct message', 'dm', settings.levelup_mode === 'dm')
    ])]),
    actionRow([channelSelect('xpbot:levelup:channel', settings.levelup_channel_id ? `Fixed destination: ${guild.channels.cache.get(settings.levelup_channel_id)?.name || 'selected channel'}` : 'Choose a fixed level-up channel')]),
    textDisplay('Choosing a channel sets a fixed destination. To change back to an automatic mode, use the mode dropdown above.')
  ], 0x57F287)];
}

export function buildChatXpPanel(guild) {
  const s = getSettings(guild.id);
  return [container([
    heading('💬 Chat XP settings'),
    textDisplay(`**Status:** ${s.chat_enabled ? '🟢 Enabled' : '🔴 Disabled'}\n**XP range:** ${s.chat_xp_min}–${s.chat_xp_max} per eligible message\n**Cooldown:** ${s.chat_cooldown_seconds} seconds per member\n**Minimum message length:** ${s.min_message_length} non-space characters`),
    separator(),
    actionRow([
      button(s.chat_enabled ? 'Turn chat XP off' : 'Turn chat XP on', 'xpbot:chatxp:toggle', s.chat_enabled ? 4 : 3),
      button('Set XP range', 'xpbot:chatxp:range', 1),
      button('Set cooldown', 'xpbot:chatxp:cooldown', 2),
      button('Set minimum length', 'xpbot:chatxp:minlength', 2)
    ]),
    actionRow([button('Back to Settings', 'xpbot:nav:settings', 2), button('Open Filters', 'xpbot:nav:filters', 2)])
  ], 0x5865F2)];
}

export function buildVoiceXpPanel(guild) {
  const s = getSettings(guild.id);
  return [container([
    heading('🎧 Voice XP settings'),
    textDisplay(`**Status:** ${s.voice_enabled ? '🟢 Enabled' : '🔴 Disabled'}\n**XP range:** ${s.voice_xp_min}–${s.voice_xp_max} per eligible interval\n**Interval:** ${s.voice_interval_seconds} seconds\n\nVoice XP requires at least two human members and is not awarded in the AFK channel or while a member is deafened.`),
    separator(),
    actionRow([
      button(s.voice_enabled ? 'Turn voice XP off' : 'Turn voice XP on', 'xpbot:voicexp:toggle', s.voice_enabled ? 4 : 3),
      button('Set XP range', 'xpbot:voicexp:range', 1),
      button('Set interval', 'xpbot:voicexp:interval', 2)
    ]),
    actionRow([button('Back to Settings', 'xpbot:nav:settings', 2), button('Open Filters', 'xpbot:nav:filters', 2)])
  ], 0x5865F2)];
}

function formatFilterEntries(guild, kind, ids) {
  if (!ids.length) return '*No entries configured.*';
  return ids.slice(0, 12).map(id => {
    const target = kind === 'channel' ? guild.channels.cache.get(id) : guild.roles.cache.get(id);
    return `• ${target ? target.toString() : (kind === 'channel' ? `<#${id}>` : `<@&${id}>`)}`;
  }).join('\n') + (ids.length > 12 ? `\n…and ${ids.length - 12} more.` : '');
}

export function buildFilterPanel(guild, state = {}) {
  const kind = ['channel', 'role', 'member'].includes(state.kind) ? state.kind : 'channel';
  const scope = (kind === 'member' ? ['chat', 'voice', 'all'] : ['chat', 'voice']).includes(state.scope) ? state.scope : 'chat';
  const mode = kind === 'member' ? null : getFilterMode(guild.id, scope, kind);
  const selectedTarget = state.targetId ? (kind === 'channel' ? guild.channels.cache.get(state.targetId) : kind === 'role' ? guild.roles.cache.get(state.targetId) : null) : null;
  let details = '';
  if (kind === 'member') {
    const rows = db.prepare("SELECT user_id, scope FROM excluded_members WHERE guild_id = ? AND (scope = ? OR scope = 'all' OR ? = 'all') ORDER BY created_at DESC LIMIT 12").all(guild.id, scope, scope);
    details = `**Excluded members (${scope} scope)**\n${rows.length ? rows.map(row => `• <@${row.user_id}> — ${row.scope}`).join('\n') : '*No excluded members in this scope.*'}`;
  } else {
    const ids = getFilterEntries(guild.id, scope, kind);
    const warning = mode === 'whitelist' && ids.length === 0 ? '\n⚠️ **This whitelist is empty. No member will qualify until you add an entry.**' : '';
    details = `**${kind === 'channel' ? 'Channels' : 'Roles'} in ${scope} ${mode} list (${ids.length})**${warning}\n${formatFilterEntries(guild, kind, ids)}`;
  }
  const targetDescription = state.targetId
    ? `**Selected target:** ${kind === 'member' ? `<@${state.targetId}>` : (selectedTarget ? selectedTarget.toString() : state.targetLabel || state.targetId)}`
    : '**Selected target:** none — choose one from the target dropdown.';
  const components = [
    heading('🧰 Interactive XP filters'),
    textDisplay('Use dropdowns to choose what to filter, XP scope, and (for channels/roles) whitelist or blacklist mode. Select a target, then apply the action.'),
    separator(),
    textDisplay(`**Current selection:** ${kind} · ${scope}${mode ? ` · ${mode}` : ''}\n${targetDescription}\n\n${state.notice ? `**Last action:** ${state.notice}\n\n` : ''}${details}`),
    actionRow([stringSelect('xpbot:filter:kind', 'Filter type', [option('Channel', 'channel', kind === 'channel'), option('Role', 'role', kind === 'role'), option('Member', 'member', kind === 'member')])]),
    actionRow([stringSelect('xpbot:filter:scope', 'XP scope', [option('Chat XP', 'chat', scope === 'chat'), option('Voice XP', 'voice', scope === 'voice'), ...(kind === 'member' ? [option('All XP', 'all', scope === 'all')] : [])])])
  ];
  if (kind === 'member') {
    components.push(actionRow([userSelect('xpbot:filter:target-user', 'Select a member to include or exclude')]));
    components.push(actionRow([
      button('Exclude member', 'xpbot:filter:exclude', 4),
      button('Include member', 'xpbot:filter:include', 3),
      button('Refresh list', 'xpbot:filter:list', 2),
      button('Back to Settings', 'xpbot:nav:settings', 2)
    ]));
  } else {
    components.push(actionRow([stringSelect('xpbot:filter:mode', 'Filter behavior', [option('Whitelist: only these qualify', 'whitelist', mode === 'whitelist'), option('Blacklist: these do not qualify', 'blacklist', mode === 'blacklist')])]));
    components.push(actionRow([kind === 'channel' ? channelSelect('xpbot:filter:target-channel', 'Select a channel to add or remove') : roleSelect('xpbot:filter:target-role', 'Select a role to add or remove')]));
    components.push(actionRow([
      button('Add selected', 'xpbot:filter:add', 3),
      button('Remove selected', 'xpbot:filter:remove', 4),
      button('Refresh list', 'xpbot:filter:list', 2),
      button('Back to Settings', 'xpbot:nav:settings', 2)
    ]));
  }
  return [container(components, 0x5865F2)];
}

export function buildMultiplierPanel(guild, state = {}) {
  const targetType = state.targetType === 'role' ? 'role' : 'channel';
  const rows = db.prepare('SELECT target_type, target_id, multiplier FROM xp_multipliers WHERE guild_id = ? ORDER BY target_type, target_id').all(guild.id);
  const list = rows.length ? rows.slice(0, 12).map(row => {
    const target = row.target_type === 'channel' ? guild.channels.cache.get(row.target_id) : guild.roles.cache.get(row.target_id);
    return `• ${row.target_type}: ${target || (row.target_type === 'channel' ? `<#${row.target_id}>` : `<@&${row.target_id}>`)} — **×${row.multiplier}**`;
  }).join('\n') + (rows.length > 12 ? `\n…and ${rows.length - 12} more.` : '') : '*No multipliers configured. Eligible members receive base XP.*';
  const selectedTarget = state.targetId ? (targetType === 'channel' ? guild.channels.cache.get(state.targetId) : guild.roles.cache.get(state.targetId)) : null;
  const components = [
    heading('✖️ XP multiplier manager'),
    textDisplay('Choose a channel or role, select it, then set a multiplier from **0.1× to 5×**. Applicable channel and role multipliers stack and the final result is capped at 5×.'),
    separator(),
    textDisplay(`**Multiplier system:** ${getSettings(guild.id).multipliers_enabled ? '🟢 Enabled' : '🔴 Disabled'}\n**Selected:** ${state.targetId ? (selectedTarget || state.targetLabel || state.targetId) : 'none'}\n\n**Configured multipliers (${rows.length})**\n${list}`),
    actionRow([stringSelect('xpbot:multiplier:type', 'Apply multiplier to…', [option('Channel', 'channel', targetType === 'channel'), option('Role', 'role', targetType === 'role')])]),
    actionRow([targetType === 'channel' ? channelSelect('xpbot:multiplier:target-channel', 'Select a channel') : roleSelect('xpbot:multiplier:target-role', 'Select a role')]),
    actionRow([
      button('Set / update value', 'xpbot:multiplier:set', 3),
      button('Remove selected', 'xpbot:multiplier:remove', 4),
      button('Refresh list', 'xpbot:multiplier:list', 2),
      button(getSettings(guild.id).multipliers_enabled ? 'Disable system' : 'Enable system', 'xpbot:multiplier:toggle', getSettings(guild.id).multipliers_enabled ? 4 : 3),
      button('Back to Settings', 'xpbot:nav:settings', 2)
    ])
  ];
  return [container(components, 0x5865F2)];
}

export function buildRewardsPanel(guild, state = {}) {
  const rows = db.prepare('SELECT level, role_id FROM level_rewards WHERE guild_id = ? ORDER BY level').all(guild.id);
  const selectedLevel = state.level == null ? '' : String(state.level);
  const list = rows.length ? rows.slice(0, 12).map(row => `• Level **${row.level}** → <@&${row.role_id}>`).join('\n') + (rows.length > 12 ? `\n…and ${rows.length - 12} more.` : '') : '*No role rewards configured yet.*';
  const role = state.roleId ? guild.roles.cache.get(state.roleId) : null;
  const levelOptions = rows.slice(0, 25).map(row => option(`Level ${row.level} → ${guild.roles.cache.get(row.role_id)?.name || row.role_id}`, String(row.level), selectedLevel === String(row.level)));
  if (!levelOptions.length) levelOptions.push(option('No rewards configured', 'none', true, 'Add a reward first'));
  return [container([
    heading('🎁 Level reward manager'),
    textDisplay('Choose a role, enter the level to award it, and save. To remove a reward, select its level and click Remove. The bot needs **Manage Roles**, and its top role must be above reward roles.'),
    separator(),
    textDisplay(`**Selected role:** ${role || state.roleId || 'none'}\n**Selected reward level:** ${selectedLevel || 'none'}\n\n**Configured rewards (${rows.length})**\n${list}`),
    actionRow([roleSelect('xpbot:rewards:role', 'Select the reward role')]),
    actionRow([stringSelect('xpbot:rewards:level', 'Select a level to remove', levelOptions)]),
    actionRow([
      button('Add / update reward', 'xpbot:rewards:set', 3),
      button('Remove selected level', 'xpbot:rewards:remove', 4),
      button('Refresh list', 'xpbot:rewards:list', 2),
      button('Back to Settings', 'xpbot:nav:settings', 2)
    ])
  ], 0x5865F2)];
}

export function buildHelpCard(prefix, canManageServer = false) {
  const sections = [
    textDisplay('# 📚 XP Bot Help\nChat and voice XP, ranks, and leaderboards.'),
    separator(),
    textDisplay(`## 👤 Member commands\n\`${prefix}rank [@member]\` · \`/rank [user]\` — view XP, level, and progress\n\`${prefix}leaderboard [all|chat|voice] [page]\` · \`/leaderboard\` — combined or separate leaderboards\n\`${prefix}ping\` · \`/ping\` — check bot responsiveness\n\`${prefix}prefix\` · \`/prefix\` — see the server prefix\n\`${prefix}help\` — public member help · \`/help\` — private, permission-aware help`)
  ];

  if (canManageServer) {
    sections.push(
      separator(),
      textDisplay('## 🛠️ Server administration\n*Visible here because you have **Manage Server** permission.*'),
      textDisplay(`**Interactive panels**\n\`${prefix}settings\` · \`/settings\` — main settings\n\`${prefix}filter\` · \`/filter\` — channel, role, and member XP filters\n\`${prefix}chatxp\` / \`${prefix}voicexp\` · \`/chatxp\` / \`/voicexp\` — enable XP and edit ranges, cooldowns, message length, and voice interval\n\`${prefix}multiplier\` · \`/multiplier\` — manage and toggle XP multipliers\n\`${prefix}rewards\` · \`/rewards\` — configure level reward roles\n\`${prefix}levelup\` · \`/levelup settings\` — set destination, enable notices, and **edit the level-up message**`),
      textDisplay(`**Admin commands**\n\`${prefix}prefix set <prefix>\` · \`/prefix new_prefix:<prefix>\` — change prefix\n\`${prefix}xp add|remove|set|reset @member …\` · \`/xp\` — manage one member's XP\n\`${prefix}resetallxp confirm\` · \`/resetallxp\` — reset all chat and voice XP in this server (irreversible)\n\`${prefix}diag\` · \`/diag\` — diagnose configuration and permissions`),
      textDisplay('*Configuration commands require **Manage Server**. Resetting all XP cannot be undone; settings and XP in other servers are not affected.*')
    );
  } else {
    sections.push(
      separator(),
      textDisplay('🔒 **Server settings and editing tools are hidden from this help view.** Members can still use ranks and leaderboards. Administrators with **Manage Server** can use `/help` to see the private admin command guide.')
    );
  }

  sections.push(separator(), textDisplay('*Slash-command help is private. Prefix help is a normal public message, so it always shows the member-safe command list.*'));
  return [container(sections, canManageServer ? 0x5865F2 : 0x57F287)];
}

export function buildNoticeCard(title, body, accentColor = 0x5865F2) {
  return [container([textDisplay(`# ${title}`), separator(), textDisplay(body)], accentColor)];
}

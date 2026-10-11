import 'dotenv/config';
import { PermissionFlagsBits } from 'discord.js';
import {
  db, getSettings, setSetting, getUser, getFilterMode, getFilterEntries,
  setFilterMode, addFilterEntry, removeFilterEntry, setMemberExcluded, addAudit
} from './database.js';
import {
  COMPONENTS_V2_FLAG, textDisplay, separator, container, buildRankCard,
  buildLeaderboardCard, buildSettingsPanel, buildHelpCard, buildLevelUpPanel, buildChatXpPanel,
  buildVoiceXpPanel, buildFilterPanel, buildMultiplierPanel, buildRewardsPanel
} from './components.js';
import { grantXp, setUserXp, resetUserXp, resetGuildXp } from './leveling.js';

const EPHEMERAL = 1 << 6;

async function slashCard(interaction, title, body, { ephemeral = true, accentColor = 0x5865F2 } = {}) {
  const flags = COMPONENTS_V2_FLAG | (ephemeral ? EPHEMERAL : 0);
  return interaction.reply({
    flags,
    components: [container([textDisplay(`# ${title}`), separator(), textDisplay(body)], accentColor)],
    allowedMentions: { parse: [] }
  });
}

function canManageServer(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.guild?.ownerId === interaction.user.id);
}

async function requireSlashAdmin(interaction) {
  if (canManageServer(interaction)) return true;
  await slashCard(interaction, 'Permission required', 'This command requires **Manage Server** permission.');
  return false;
}

function channelTarget(interaction) {
  return interaction.options.getChannel('channel');
}

function roleTarget(interaction) {
  return interaction.options.getRole('role');
}

function displayFilterTarget(guild, kind, id) {
  const target = kind === 'channel' ? guild.channels.cache.get(id) : guild.roles.cache.get(id);
  return target ? `${target}` : kind === 'channel' ? `<#${id}>` : `<@&${id}>`;
}

async function handleSlashFilter(interaction) {
  if (!(await requireSlashAdmin(interaction))) return;
  const guildId = interaction.guild.id;
  const entity = interaction.options.getString('entity');
  const scope = interaction.options.getString('scope');
  const action = interaction.options.getString('action');
  if (!entity || !scope || !action) {
    return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildFilterPanel(interaction.guild), allowedMentions: { parse: [] } });
  }

  if (entity === 'member') {
    if (!['chat', 'voice', 'all'].includes(scope)) return slashCard(interaction, 'Invalid scope', 'Choose chat, voice, or all.');
    if (action === 'list') {
      const rows = db.prepare("SELECT user_id, scope FROM excluded_members WHERE guild_id = ? AND (scope = ? OR scope = 'all' OR ? = 'all') ORDER BY created_at DESC LIMIT 50")
        .all(guildId, scope, scope);
      const body = rows.length ? rows.map(row => `• <@${row.user_id}> — **${row.scope}**`).join('\n') : 'No excluded members found for this scope.';
      return slashCard(interaction, 'Excluded members', body);
    }
    if (!['exclude', 'include'].includes(action)) return slashCard(interaction, 'Invalid action', 'For a member filter, choose exclude, include, or list.');
    const user = interaction.options.getUser('user');
    if (!user) return slashCard(interaction, 'Member required', 'Choose a user target.');
    setMemberExcluded(guildId, user.id, scope, action === 'exclude');
    addAudit(guildId, interaction.user.id, `member_filter_${action}`, user.id, scope);
    return slashCard(interaction, 'Member filter updated', `<@${user.id}> ${action === 'exclude' ? 'will not earn' : 'can earn'} ${scope === 'all' ? 'chat or voice' : scope} XP.`, { accentColor: 0x57F287 });
  }

  if (!['chat', 'voice'].includes(scope)) return slashCard(interaction, 'Invalid scope', 'Channel/role filters must use chat or voice scope.');
  if (['whitelist', 'blacklist'].includes(action)) {
    setFilterMode(guildId, scope, entity, action);
    addAudit(guildId, interaction.user.id, 'filter_mode_set', null, `${entity}/${scope}/${action}`);
    const count = getFilterEntries(guildId, scope, entity).length;
    const warning = action === 'whitelist' && count === 0 ? '\n⚠️ The whitelist is empty, so nobody currently qualifies.' : '';
    return slashCard(interaction, 'Filter mode updated', `${entity} ${scope} filter is now **${action}**. Entries: ${count}.${warning}`, { accentColor: 0x57F287 });
  }
  if (action === 'list') {
    const ids = getFilterEntries(guildId, scope, entity);
    const body = ids.length ? ids.map(id => `• ${displayFilterTarget(interaction.guild, entity, id)}`).join('\n') : 'No entries configured.';
    return slashCard(interaction, `${entity} filters · ${scope}`, `Mode: **${getFilterMode(guildId, scope, entity)}**\n${body}`);
  }
  if (!['add', 'remove'].includes(action)) return slashCard(interaction, 'Invalid action', 'For channel/role filters choose add, remove, list, whitelist, or blacklist.');
  const target = entity === 'channel' ? channelTarget(interaction) : roleTarget(interaction);
  if (!target) return slashCard(interaction, 'Target required', `Choose a ${entity}.`);
  const changed = action === 'add'
    ? addFilterEntry(guildId, scope, entity, target.id)
    : removeFilterEntry(guildId, scope, entity, target.id);
  addAudit(guildId, interaction.user.id, `filter_${action}`, target.id, `${entity}/${scope}`);
  return slashCard(interaction, 'Filter updated', `${target} ${changed ? (action === 'add' ? 'added to' : 'removed from') : (action === 'add' ? 'was already in' : 'was not in')} the **${scope} ${entity} ${getFilterMode(guildId, scope, entity)}** list.`, { accentColor: 0x57F287 });
}

async function handleSlashCommand(interaction, client) {
  const guild = interaction.guild;
  if (!guild) return slashCard(interaction, 'Server only', 'This command must be used inside a server.');
  const name = interaction.commandName;
  const settings = getSettings(guild.id);

  if (name === 'ping') {
    const latency = Number.isFinite(client.ws.ping) ? `${Math.round(client.ws.ping)} ms` : 'not available';
    return slashCard(interaction, 'Pong!', `The slash-command handler is responding.
Gateway latency: **${latency}**
Connected servers: **${client.guilds.cache.size}**.`, { ephemeral: true, accentColor: 0x57F287 });
  }
  if (name === 'help') {
    // Ephemeral replies allow each member to see only the command sections appropriate to their permissions.
    return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildHelpCard(settings.prefix, canManageServer(interaction)), allowedMentions: { parse: [] } });
  }
  if (name === 'rank') {
    const target = interaction.options.getUser('user') || interaction.user;
    const user = target.id === client.user.id ? target : await client.users.fetch(target.id).catch(() => target);
    return interaction.reply({ flags: COMPONENTS_V2_FLAG, components: await buildRankCard(guild, user), allowedMentions: { parse: [] } });
  }
  if (name === 'leaderboard') {
    const scope = interaction.options.getString('scope') || 'all';
    const page = interaction.options.getInteger('page') || 1;
    return interaction.reply({ flags: COMPONENTS_V2_FLAG, components: buildLeaderboardCard(guild, scope, page), allowedMentions: { parse: [] } });
  }
  if (name === 'settings') {
    if (!(await requireSlashAdmin(interaction))) return;
    return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildSettingsPanel(guild), allowedMentions: { parse: [] } });
  }
  if (name === 'prefix') {
    const requestedPrefix = interaction.options.getString('new_prefix');
    if (!requestedPrefix) return slashCard(interaction, 'Server prefix', `Current prefix: \`${settings.prefix}\`.` , { ephemeral: false });
    if (!(await requireSlashAdmin(interaction))) return;
    if (requestedPrefix.length > 5 || /\s/.test(requestedPrefix) || /<@!?\d+>/.test(requestedPrefix)) {
      return slashCard(interaction, 'Invalid prefix', 'Choose a prefix that is 1–5 characters long with no spaces or user mention.');
    }
    setSetting(guild.id, 'prefix', requestedPrefix);
    addAudit(guild.id, interaction.user.id, 'prefix_set', null, requestedPrefix);
    return slashCard(interaction, 'Prefix updated', `Prefix is now \`${requestedPrefix}\`.`, { accentColor: 0x57F287 });
  }
  if (name === 'chatxp') {
    if (!(await requireSlashAdmin(interaction))) return;
    const action = interaction.options.getString('action') || 'panel';
    if (action === 'panel') return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildChatXpPanel(guild), allowedMentions: { parse: [] } });
    if (action === 'show') return slashCard(interaction, 'Chat XP settings', `Status: **${settings.chat_enabled ? 'enabled' : 'disabled'}**\nRange: ${settings.chat_xp_min}–${settings.chat_xp_max} XP\nCooldown: ${settings.chat_cooldown_seconds}s\nMinimum length: ${settings.min_message_length}.`);
    if (['on', 'off', 'toggle'].includes(action)) {
      const enabled = action === 'toggle' ? (getSettings(guild.id).chat_enabled ? 0 : 1) : (action === 'on' ? 1 : 0);
      setSetting(guild.id, 'chat_enabled', enabled);
      addAudit(guild.id, interaction.user.id, 'chat_xp_toggle', null, Boolean(enabled));
      return slashCard(interaction, 'Chat XP updated', `Chat XP is now **${enabled ? 'enabled' : 'disabled'}**.`, { accentColor: enabled ? 0x57F287 : 0xED4245 });
    }
    if (action === 'range') {
      const min = interaction.options.getInteger('min'); const max = interaction.options.getInteger('max');
      if (min == null || max == null || max < min) return slashCard(interaction, 'Range required', 'Provide minimum and maximum XP; maximum must be at least minimum.');
      setSetting(guild.id, 'chat_xp_min', min); setSetting(guild.id, 'chat_xp_max', max);
      return slashCard(interaction, 'Chat XP range updated', `Eligible messages now grant **${min}–${max} XP** before multipliers.`, { accentColor: 0x57F287 });
    }
    if (action === 'cooldown') {
      const seconds = interaction.options.getInteger('seconds');
      if (seconds == null) return slashCard(interaction, 'Cooldown required', 'Provide seconds (5–3600).');
      setSetting(guild.id, 'chat_cooldown_seconds', seconds);
      return slashCard(interaction, 'Chat XP cooldown updated', `Cooldown is now **${seconds} seconds**.`, { accentColor: 0x57F287 });
    }
    if (action === 'minlength') {
      const chars = interaction.options.getInteger('characters');
      if (chars == null) return slashCard(interaction, 'Minimum length required', 'Provide a value from 1 to 500.');
      setSetting(guild.id, 'min_message_length', chars);
      return slashCard(interaction, 'Minimum message length updated', `Eligible messages must contain at least **${chars} non-space characters**.`, { accentColor: 0x57F287 });
    }
  }
  if (name === 'voicexp') {
    if (!(await requireSlashAdmin(interaction))) return;
    const action = interaction.options.getString('action') || 'panel';
    if (action === 'panel') return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildVoiceXpPanel(guild), allowedMentions: { parse: [] } });
    if (action === 'show') return slashCard(interaction, 'Voice XP settings', `Status: **${settings.voice_enabled ? 'enabled' : 'disabled'}**\nRange: ${settings.voice_xp_min}–${settings.voice_xp_max} XP\nInterval: ${settings.voice_interval_seconds}s.`);
    if (['on', 'off', 'toggle'].includes(action)) {
      const enabled = action === 'toggle' ? (getSettings(guild.id).voice_enabled ? 0 : 1) : (action === 'on' ? 1 : 0);
      setSetting(guild.id, 'voice_enabled', enabled);
      addAudit(guild.id, interaction.user.id, 'voice_xp_toggle', null, Boolean(enabled));
      return slashCard(interaction, 'Voice XP updated', `Voice XP is now **${enabled ? 'enabled' : 'disabled'}**.`, { accentColor: enabled ? 0x57F287 : 0xED4245 });
    }
    if (action === 'range') {
      const min = interaction.options.getInteger('min'); const max = interaction.options.getInteger('max');
      if (min == null || max == null || max < min) return slashCard(interaction, 'Range required', 'Provide minimum and maximum XP; maximum must be at least minimum.');
      setSetting(guild.id, 'voice_xp_min', min); setSetting(guild.id, 'voice_xp_max', max);
      return slashCard(interaction, 'Voice XP range updated', `Each eligible interval now grants **${min}–${max} XP**.`, { accentColor: 0x57F287 });
    }
    if (action === 'interval') {
      const seconds = interaction.options.getInteger('seconds');
      if (seconds == null) return slashCard(interaction, 'Interval required', 'Provide seconds (30–3600).');
      setSetting(guild.id, 'voice_interval_seconds', seconds);
      return slashCard(interaction, 'Voice XP interval updated', `Eligible members earn XP every **${seconds} seconds**.`, { accentColor: 0x57F287 });
    }
  }
  if (name === 'levelup') {
    if (!(await requireSlashAdmin(interaction))) return;
    const action = interaction.options.getSubcommand(true);
    const latest = getSettings(guild.id);
    if (action === 'settings') {
      return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildLevelUpPanel(guild), allowedMentions: { parse: [] } });
    }
    if (action === 'show') {
      const destination = latest.levelup_channel_id ? `<#${latest.levelup_channel_id}>` : latest.levelup_mode;
      return slashCard(interaction, 'Level-up settings', `Status: **${latest.levelup_enabled ? 'enabled' : 'disabled'}**\nMode: **${latest.levelup_mode}**\nDestination: ${destination}\nTemplate: ${latest.levelup_message}`);
    }
    if (['enable', 'disable', 'toggle'].includes(action)) {
      const enabled = action === 'enable' ? 1 : action === 'disable' ? 0 : (latest.levelup_enabled ? 0 : 1);
      setSetting(guild.id, 'levelup_enabled', enabled);
      addAudit(guild.id, interaction.user.id, 'levelup_toggle', null, Boolean(enabled));
      return slashCard(interaction, 'Level-up notifications', `Notifications are now **${enabled ? 'enabled' : 'disabled'}**.`, { accentColor: enabled ? 0x57F287 : 0xED4245 });
    }
    if (action === 'channel') {
      const channel = interaction.options.getChannel('channel', true);
      if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return slashCard(interaction, 'Text channel required', 'Select a sendable text channel for level-up notices.');
      const botMember = guild.members.me;
      const permissions = botMember ? channel.permissionsFor(botMember) : null;
      if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
        return slashCard(interaction, 'Missing channel permissions', `I need **View Channel** and **Send Messages** in ${channel}. No settings were changed.`);
      }
      setSetting(guild.id, 'levelup_mode', 'channel');
      setSetting(guild.id, 'levelup_channel_id', channel.id);
      addAudit(guild.id, interaction.user.id, 'levelup_destination', channel.id, 'channel');
      return slashCard(interaction, 'Destination updated', `Level-up notices will be sent in ${channel}. Notifications are currently **${getSettings(guild.id).levelup_enabled ? 'enabled' : 'disabled'}**.`, { accentColor: 0x57F287 });
    }
    if (action === 'mode') {
      const mode = interaction.options.getString('mode', true);
      setSetting(guild.id, 'levelup_mode', mode);
      setSetting(guild.id, 'levelup_channel_id', null);
      addAudit(guild.id, interaction.user.id, 'levelup_destination', null, mode);
      return slashCard(interaction, 'Destination updated', `Level-up destination mode is now **${mode}**.`, { accentColor: 0x57F287 });
    }
    if (action === 'message') {
      const template = interaction.options.getString('template', true);
      setSetting(guild.id, 'levelup_message', template);
      addAudit(guild.id, interaction.user.id, 'levelup_message', null, template);
      return slashCard(interaction, 'Template updated', template, { accentColor: 0x57F287 });
    }
    return slashCard(interaction, 'Unknown level-up action', 'Use /levelup show, enable, disable, toggle, channel, mode, or message.');
  }
  if (name === 'resetallxp') {
    if (!(await requireSlashAdmin(interaction))) return;
    const confirmation = interaction.options.getString('confirmation', true);
    if (confirmation !== 'confirm') return slashCard(interaction, 'Confirmation required', 'Select the explicit reset confirmation to continue.');
    const affectedUsers = resetGuildXp(guild.id);
    addAudit(guild.id, interaction.user.id, 'xp_reset_all', null, `affected_users=${affectedUsers}`);
    return slashCard(interaction, 'Server XP reset complete', `Reset chat and voice XP for **${affectedUsers} member record(s)** in this server. Server settings, filters, rewards, and other servers were not changed.`, { accentColor: 0x57F287 });
  }
  if (name === 'filter') return handleSlashFilter(interaction);
  if (name === 'multiplier') {
    if (!(await requireSlashAdmin(interaction))) return;
    const action = interaction.options.getString('action') || 'panel';
    if (action === 'panel') return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildMultiplierPanel(guild), allowedMentions: { parse: [] } });
    if (['on', 'off', 'toggle'].includes(action)) {
      const enabled = action === 'toggle' ? (getSettings(guild.id).multipliers_enabled ? 0 : 1) : (action === 'on' ? 1 : 0);
      setSetting(guild.id, 'multipliers_enabled', enabled);
      addAudit(guild.id, interaction.user.id, 'multipliers_toggle', null, Boolean(enabled));
      return slashCard(interaction, 'XP multiplier system', `The multiplier system is now **${enabled ? 'enabled' : 'disabled'}**.`, { accentColor: enabled ? 0x57F287 : 0xED4245 });
    }
    if (action === 'list') {
      const rows = db.prepare('SELECT target_type, target_id, multiplier FROM xp_multipliers WHERE guild_id = ? ORDER BY target_type, target_id').all(guild.id);
      const body = rows.length ? rows.map(row => `• ${displayFilterTarget(guild, row.target_type, row.target_id)} (${row.target_type}) — **×${row.multiplier}**`).join('\n') : 'No multipliers configured.';
      return slashCard(interaction, 'XP multipliers', `${body}\nMultipliers stack, with a final cap of ×5.`);
    }
    const targetType = interaction.options.getString('target_type');
    if (!['channel', 'role'].includes(targetType)) return slashCard(interaction, 'Target type required', 'Choose channel or role.');
    const target = targetType === 'channel' ? channelTarget(interaction) : roleTarget(interaction);
    if (!target) return slashCard(interaction, 'Target required', `Choose a ${targetType}.`);
    if (action === 'remove') {
      const result = db.prepare('DELETE FROM xp_multipliers WHERE guild_id = ? AND target_type = ? AND target_id = ?').run(guild.id, targetType, target.id);
      addAudit(guild.id, interaction.user.id, 'multiplier_remove', target.id, targetType);
      return slashCard(interaction, 'Multiplier removed', result.changes ? `Removed multiplier for ${target}.` : `No multiplier was set for ${target}.`, { accentColor: 0x57F287 });
    }
    const value = interaction.options.getNumber('value');
    if (value == null || value < 0.1 || value > 5) return slashCard(interaction, 'Multiplier value required', 'Choose a value from 0.1 to 5.');
    db.prepare(`INSERT INTO xp_multipliers (guild_id, target_type, target_id, multiplier, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, target_type, target_id) DO UPDATE SET multiplier = excluded.multiplier, updated_at = excluded.updated_at`)
      .run(guild.id, targetType, target.id, value, Date.now());
    addAudit(guild.id, interaction.user.id, 'multiplier_set', target.id, `${targetType}/${value}`);
    return slashCard(interaction, 'Multiplier saved', `${target} now has an XP multiplier of **×${value}**.`, { accentColor: 0x57F287 });
  }
  if (name === 'rewards') {
    if (!(await requireSlashAdmin(interaction))) return;
    const action = interaction.options.getString('action') || 'panel';
    if (action === 'panel') return interaction.reply({ flags: COMPONENTS_V2_FLAG | EPHEMERAL, components: buildRewardsPanel(guild), allowedMentions: { parse: [] } });
    if (action === 'list') {
      const rows = db.prepare('SELECT level, role_id FROM level_rewards WHERE guild_id = ? ORDER BY level').all(guild.id);
      const body = rows.length ? rows.map(row => `• Level **${row.level}** → <@&${row.role_id}>`).join('\n') : 'No level rewards configured.';
      return slashCard(interaction, 'Level role rewards', body);
    }
    const level = interaction.options.getInteger('level');
    if (!level) return slashCard(interaction, 'Level required', 'Provide a level number.');
    if (action === 'remove') {
      const result = db.prepare('DELETE FROM level_rewards WHERE guild_id = ? AND level = ?').run(guild.id, level);
      addAudit(guild.id, interaction.user.id, 'reward_remove', null, level);
      return slashCard(interaction, 'Level reward removed', result.changes ? `Removed reward at level ${level}.` : `No reward was set for level ${level}.`, { accentColor: 0x57F287 });
    }
    const role = roleTarget(interaction);
    if (!role) return slashCard(interaction, 'Role required', 'Choose the role to grant.');
    const botMember = guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return slashCard(interaction, 'Missing permission', 'The bot needs Manage Roles to grant rewards.');
    if (role.managed || role.position >= botMember.roles.highest.position) return slashCard(interaction, 'Role hierarchy issue', 'Move the bot role above the reward role.');
    db.prepare('INSERT INTO level_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, level) DO UPDATE SET role_id = excluded.role_id').run(guild.id, level, role.id);
    addAudit(guild.id, interaction.user.id, 'reward_set', role.id, level);
    return slashCard(interaction, 'Level reward saved', `Members will receive ${role} when they reach level **${level}**.`, { accentColor: 0x57F287 });
  }
  if (name === 'xp') {
    if (!(await requireSlashAdmin(interaction))) return;
    const action = interaction.options.getString('action', true);
    const user = interaction.options.getUser('user', true);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member || member.user.bot) return slashCard(interaction, 'Member not found', 'Choose a member of this server who is not a bot.');
    const scope = interaction.options.getString('scope') || (action === 'reset' ? 'all' : 'chat');
    if (action === 'reset') {
      if (!['chat', 'voice', 'all'].includes(scope)) return slashCard(interaction, 'Invalid scope', 'Choose chat, voice, or all.');
      await resetUserXp({ member, scope });
      addAudit(guild.id, interaction.user.id, 'xp_reset', member.id, scope);
      return slashCard(interaction, 'XP reset', `Reset **${scope} XP** for <@${member.id}>.`, { accentColor: 0x57F287 });
    }
    const amount = interaction.options.getInteger('amount');
    if (!Number.isInteger(amount) || amount < 0 || !['chat', 'voice'].includes(scope)) return slashCard(interaction, 'Amount/scope required', 'Choose amount and chat or voice scope.');
    if (action === 'add') {
      await grantXp({ member, amount, scope, reason: 'slash admin add' });
    } else if (action === 'remove') {
      const current = getUser(guild.id, member.id);
      const existing = scope === 'chat' ? current.chat_xp : current.voice_xp;
      await setUserXp({ member, amount: Math.max(0, existing - amount), scope });
    } else {
      await setUserXp({ member, amount, scope });
    }
    addAudit(guild.id, interaction.user.id, `xp_${action}`, member.id, `${scope}/${amount}`);
    const updated = getUser(guild.id, member.id);
    return slashCard(interaction, `XP ${action} complete`, `<@${member.id}> now has **${updated.chat_xp.toLocaleString()} chat XP** and **${updated.voice_xp.toLocaleString()} voice XP** (**${(updated.chat_xp + updated.voice_xp).toLocaleString()} combined**).`, { accentColor: 0x57F287 });
  }
  if (name === 'diag') {
    if (!(await requireSlashAdmin(interaction))) return;
    const botMember = guild.members.me;
    const channel = interaction.channel;
    const permissions = channel?.permissionsFor(botMember);
    const checks = [
      `${permissions?.has(PermissionFlagsBits.ViewChannel) ? '✅' : '❌'} View command channel`,
      `${permissions?.has(PermissionFlagsBits.SendMessages) ? '✅' : '❌'} Send messages in command channel`,
      `${botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ? '✅' : '⚠️'} Manage Roles (needed for rewards)`
    ];
    for (const scope of ['chat', 'voice']) for (const kind of ['channel', 'role']) {
      if (getFilterMode(guild.id, scope, kind) === 'whitelist' && getFilterEntries(guild.id, scope, kind).length === 0) checks.push(`⚠️ ${scope} ${kind} whitelist is empty.`);
    }
    if (settings.levelup_channel_id) {
      const target = await guild.channels.fetch(settings.levelup_channel_id).catch(() => null);
      const targetPermissions = target?.permissionsFor(botMember);
      checks.push(`${target && targetPermissions?.has(PermissionFlagsBits.SendMessages) ? '✅' : '❌'} Send level-up notices in configured channel`);
    }
    if (settings.voice_enabled) checks.push('ℹ️ Voice XP requires two human members, and skips AFK/deafened members.');
    return slashCard(interaction, 'Diagnostics', checks.join('\n'), { accentColor: checks.some(check => check.startsWith('❌')) ? 0xED4245 : 0x57F287 });
  }
}

export { handleSlashCommand };

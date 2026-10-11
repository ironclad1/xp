import 'dotenv/config';
import { PermissionFlagsBits } from 'discord.js';
import { db, getSettings, ensureUser, getUser, getFilterMode, getFilterEntries, isMemberExcluded } from './database.js';
import { sendV2, textDisplay } from './components.js';

import { getLevel } from './xpMath.js';

export function isXpAllowed(member, scope, channelId) {
  const guildId = member.guild.id;
  const userId = member.id;
  const settings = getSettings(guildId);
  if (scope === 'chat' && !settings.chat_enabled) return { allowed: false, reason: 'Chat XP is disabled.' };
  if (scope === 'voice' && !settings.voice_enabled) return { allowed: false, reason: 'Voice XP is disabled.' };
  if (isMemberExcluded(guildId, userId, scope)) return { allowed: false, reason: 'This member is excluded from XP.' };

  const channelMode = getFilterMode(guildId, scope, 'channel');
  const channelEntries = getFilterEntries(guildId, scope, 'channel');
  const channelIsListed = channelEntries.includes(String(channelId));
  if (channelMode === 'whitelist' && !channelIsListed) return { allowed: false, reason: 'Channel is not whitelisted.' };
  if (channelMode === 'blacklist' && channelIsListed) return { allowed: false, reason: 'Channel is blacklisted.' };

  const roleMode = getFilterMode(guildId, scope, 'role');
  const roleEntries = getFilterEntries(guildId, scope, 'role');
  if (roleMode === 'whitelist') {
    if (!roleEntries.length) return { allowed: false, reason: 'Role whitelist is empty.' };
    const userRoleIds = new Set([guildId, ...member.roles.cache.keys()].map(String));
    if (!roleEntries.some(roleId => userRoleIds.has(String(roleId)))) {
      return { allowed: false, reason: 'Member has no whitelisted role.' };
    }
  } else if (roleEntries.some(roleId => String(roleId) === guildId || member.roles.cache.has(String(roleId)))) {
    return { allowed: false, reason: 'Member has a blacklisted role.' };
  }

  return { allowed: true, reason: null };
}

export function getXpMultiplier(guildId, member, channelId) {
  if (!getSettings(guildId).multipliers_enabled) return 1;
  const rows = db.prepare('SELECT target_type, target_id, multiplier FROM xp_multipliers WHERE guild_id = ?').all(guildId);
  let multiplier = 1;
  for (const row of rows) {
    if (row.target_type === 'channel' && String(row.target_id) === String(channelId)) {
      multiplier *= row.multiplier;
    } else if (row.target_type === 'role' && member.roles.cache.has(String(row.target_id))) {
      multiplier *= row.multiplier;
    }
  }
  return Math.max(0.1, Math.min(5, multiplier));
}

export function randomInteger(min, max) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (high - low + 1)) + low;
}

async function giveLevelRewards(member, oldLevel, newLevel) {
  const rewards = db.prepare('SELECT level, role_id FROM level_rewards WHERE guild_id = ? AND level > ? AND level <= ? ORDER BY level ASC')
    .all(member.guild.id, oldLevel, newLevel);
  const granted = [];
  for (const reward of rewards) {
    try {
      const role = await member.guild.roles.fetch(reward.role_id);
      if (!role) continue;
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role, `XP level reward: reached level ${reward.level}`);
      }
      granted.push(role.name);
    } catch (error) {
      console.warn(`[rewards] Could not grant role ${reward.role_id} to ${member.id}: ${error.message}`);
    }
  }
  return granted;
}

async function sendLevelUpNotice(member, level, totalXp, sourceChannel) {
  const guild = member.guild;
  const settings = getSettings(guild.id);
  if (!settings.levelup_enabled) return;

  const configuredChannel = settings.levelup_channel_id
    ? await guild.channels.fetch(settings.levelup_channel_id).catch(() => null)
    : null;
  const systemChannel = guild.systemChannel || null;
  let destination = null;

  if (settings.levelup_mode === 'dm') {
    destination = await member.createDM().catch(() => null);
  } else if (settings.levelup_mode === 'channel') {
    // A fixed destination is strict: never silently send to a different channel.
    destination = configuredChannel;
  } else if (settings.levelup_mode === 'current') {
    destination = sourceChannel?.isTextBased?.() && typeof sourceChannel.send === 'function'
      ? sourceChannel
      : systemChannel;
  } else if (settings.levelup_mode === 'system') {
    destination = systemChannel;
  } else {
    // Automatic: chat level-ups go to the active channel; voice level-ups use the system channel if available.
    destination = sourceChannel?.isTextBased?.() && typeof sourceChannel.send === 'function'
      ? sourceChannel
      : (configuredChannel || systemChannel);
  }

  const isDm = settings.levelup_mode === 'dm';
  const canSendTo = channel => {
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;
    const botMember = guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.SendMessages));
  };

  if (!isDm && !canSendTo(destination) && settings.levelup_mode !== 'channel') {
    // Only automatic/current modes may find a permitted fallback channel.
    destination = guild.channels.cache.find(canSendTo) || null;
  }
  if (isDm && !destination?.send) {
    console.warn(`[levelup] Could not open DM for ${member.id} in guild ${guild.id}.`);
    return;
  }
  if (!destination?.send || (!isDm && !canSendTo(destination))) {
    console.warn(`[levelup] Configured destination unavailable or missing permissions in guild ${guild.id}; mode=${settings.levelup_mode}, channel=${settings.levelup_channel_id || 'none'}.`);
    return;
  }

  const template = settings.levelup_message || '{user} reached **Level {level}** in **{server}**! Keep it up!';
  const rendered = template
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{level}', String(level))
    .replaceAll('{server}', guild.name)
    .replaceAll('{xp}', String(totalXp));
  try {
    await sendV2(destination, [
      textDisplay('# 🎉 Level Up!'),
      textDisplay(rendered)
    ], {
      accentColor: 0x57F287,
      allowedMentions: { users: [member.id], roles: [] }
    });
  } catch (error) {
    console.warn(`[levelup] Could not send notification in guild ${guild.id}: ${error.message}`);
  }
}

export async function grantXp({ member, amount, scope, sourceChannel = null, reason = 'activity' }) {
  if (!member?.guild || !['chat', 'voice'].includes(scope)) throw new Error('grantXp requires a guild member and chat/voice scope.');
  const guildId = member.guild.id;
  const userId = member.id;
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  if (!safeAmount) return { amount: 0, oldLevel: getLevel(getUser(guildId, userId).chat_xp + getUser(guildId, userId).voice_xp), newLevel: null };

  ensureUser(guildId, userId);
  const before = getUser(guildId, userId);
  const oldTotal = before.chat_xp + before.voice_xp;
  const oldLevel = getLevel(oldTotal);
  const column = scope === 'chat' ? 'chat_xp' : 'voice_xp';
  const now = Date.now();
  db.prepare(`UPDATE users SET ${column} = ${column} + ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`)
    .run(safeAmount, now, guildId, userId);
  const after = getUser(guildId, userId);
  const totalXp = after.chat_xp + after.voice_xp;
  const newLevel = getLevel(totalXp);

  if (newLevel > oldLevel) {
    await giveLevelRewards(member, oldLevel, newLevel);
    await sendLevelUpNotice(member, newLevel, totalXp, sourceChannel);
  }

  if (process.env.DEBUG === 'true') {
    console.log(`[xp] ${member.user.tag} +${safeAmount} ${scope} XP (${reason}); level ${oldLevel} -> ${newLevel}`);
  }
  return { amount: safeAmount, oldLevel, newLevel, totalXp, chatXp: after.chat_xp, voiceXp: after.voice_xp };
}

export async function setUserXp({ member, amount, scope }) {
  if (!member?.guild || !['chat', 'voice'].includes(scope)) throw new Error('setUserXp requires a guild member and chat/voice scope.');
  const guildId = member.guild.id;
  ensureUser(guildId, member.id);
  const before = getUser(guildId, member.id);
  const oldLevel = getLevel(before.chat_xp + before.voice_xp);
  const column = scope === 'chat' ? 'chat_xp' : 'voice_xp';
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  db.prepare(`UPDATE users SET ${column} = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`)
    .run(safeAmount, Date.now(), guildId, member.id);
  const after = getUser(guildId, member.id);
  const totalXp = after.chat_xp + after.voice_xp;
  const newLevel = getLevel(totalXp);
  if (newLevel > oldLevel) {
    await giveLevelRewards(member, oldLevel, newLevel);
    await sendLevelUpNotice(member, newLevel, totalXp, null);
  }
  return { before, after, oldLevel, newLevel };
}

export async function resetUserXp({ member, scope = 'all' }) {
  if (!member?.guild || !['chat', 'voice', 'all'].includes(scope)) throw new Error('resetUserXp scope must be chat, voice, or all.');
  ensureUser(member.guild.id, member.id);
  const column = scope === 'chat' ? 'chat_xp = 0' : scope === 'voice' ? 'voice_xp = 0' : 'chat_xp = 0, voice_xp = 0';
  db.prepare(`UPDATE users SET ${column}, updated_at = ? WHERE guild_id = ? AND user_id = ?`).run(Date.now(), member.guild.id, member.id);
  return getUser(member.guild.id, member.id);
}

export function resetGuildXp(guildId) {
  if (!guildId) throw new Error('resetGuildXp requires a guild ID.');
  const now = Date.now();
  return db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM users WHERE guild_id = ? AND (chat_xp > 0 OR voice_xp > 0)').get(guildId).count;
    db.prepare('UPDATE users SET chat_xp = 0, voice_xp = 0, last_chat_xp_at = 0, updated_at = ? WHERE guild_id = ?').run(now, guildId);
    return count;
  })();
}

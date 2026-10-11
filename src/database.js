import 'dotenv/config';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const configuredPath = process.env.DB_PATH || './data/xpbot.sqlite';
const databasePath = resolve(configuredPath);
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL DEFAULT '!',
    chat_enabled INTEGER NOT NULL DEFAULT 1,
    voice_enabled INTEGER NOT NULL DEFAULT 1,
    multipliers_enabled INTEGER NOT NULL DEFAULT 1,
    chat_xp_min INTEGER NOT NULL DEFAULT 15,
    chat_xp_max INTEGER NOT NULL DEFAULT 25,
    chat_cooldown_seconds INTEGER NOT NULL DEFAULT 60,
    min_message_length INTEGER NOT NULL DEFAULT 5,
    voice_xp_min INTEGER NOT NULL DEFAULT 5,
    voice_xp_max INTEGER NOT NULL DEFAULT 10,
    voice_interval_seconds INTEGER NOT NULL DEFAULT 60,
    levelup_enabled INTEGER NOT NULL DEFAULT 1,
    levelup_mode TEXT NOT NULL DEFAULT 'auto',
    levelup_channel_id TEXT,
    levelup_message TEXT NOT NULL DEFAULT '{user} reached **Level {level}** in **{server}**! Keep it up!',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS users (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chat_xp INTEGER NOT NULL DEFAULT 0 CHECK(chat_xp >= 0),
    voice_xp INTEGER NOT NULL DEFAULT 0 CHECK(voice_xp >= 0),
    last_chat_xp_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS filter_configs (
    guild_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('chat', 'voice')),
    kind TEXT NOT NULL CHECK(kind IN ('channel', 'role')),
    mode TEXT NOT NULL DEFAULT 'blacklist' CHECK(mode IN ('whitelist', 'blacklist')),
    PRIMARY KEY (guild_id, scope, kind)
  );

  CREATE TABLE IF NOT EXISTS filter_entries (
    guild_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('chat', 'voice')),
    kind TEXT NOT NULL CHECK(kind IN ('channel', 'role')),
    target_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (guild_id, scope, kind, target_id)
  );

  CREATE TABLE IF NOT EXISTS excluded_members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('chat', 'voice', 'all')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (guild_id, user_id, scope)
  );

  CREATE TABLE IF NOT EXISTS xp_multipliers (
    guild_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('channel', 'role')),
    target_id TEXT NOT NULL,
    multiplier REAL NOT NULL CHECK(multiplier >= 0.1 AND multiplier <= 5.0),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (guild_id, target_type, target_id)
  );

  CREATE TABLE IF NOT EXISTS level_rewards (
    guild_id TEXT NOT NULL,
    level INTEGER NOT NULL CHECK(level >= 1),
    role_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (guild_id, level)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT,
    details TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_users_chat_xp ON users(guild_id, chat_xp DESC);
  CREATE INDEX IF NOT EXISTS idx_users_voice_xp ON users(guild_id, voice_xp DESC);
  CREATE INDEX IF NOT EXISTS idx_users_updated ON users(guild_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_guild_created ON audit_log(guild_id, created_at DESC);
`);

// Safe, backward-compatible schema migration for existing bot databases.
const guildSettingColumns = new Set(db.prepare('PRAGMA table_info(guild_settings)').all().map(column => column.name));
if (!guildSettingColumns.has('multipliers_enabled')) {
  db.exec('ALTER TABLE guild_settings ADD COLUMN multipliers_enabled INTEGER NOT NULL DEFAULT 1');
}

// Safe settings keys that commands are allowed to change.
const allowedSettings = new Set([
  'prefix', 'chat_enabled', 'voice_enabled', 'multipliers_enabled', 'chat_xp_min', 'chat_xp_max',
  'chat_cooldown_seconds', 'min_message_length', 'voice_xp_min', 'voice_xp_max',
  'voice_interval_seconds', 'levelup_enabled', 'levelup_mode', 'levelup_channel_id',
  'levelup_message'
]);

export function getSettings(guildId) {
  const defaultPrefix = (process.env.DEFAULT_PREFIX || '!').slice(0, 5) || '!';
  db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id, prefix) VALUES (?, ?)').run(guildId, defaultPrefix);
  return db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
}

export function setSetting(guildId, key, value) {
  if (!allowedSettings.has(key)) throw new Error(`Unsupported settings key: ${key}`);
  getSettings(guildId);
  db.prepare(`UPDATE guild_settings SET ${key} = ?, updated_at = ? WHERE guild_id = ?`).run(value, Date.now(), guildId);
  return getSettings(guildId);
}

export function ensureUser(guildId, userId) {
  db.prepare('INSERT OR IGNORE INTO users (guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
  return db.prepare('SELECT * FROM users WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

export function getUser(guildId, userId) {
  return ensureUser(guildId, userId);
}

export function getLeaderboard(guildId, scope = 'all', limit = 10, offset = 0) {
  const expression = scope === 'chat' ? 'chat_xp' : scope === 'voice' ? 'voice_xp' : '(chat_xp + voice_xp)';
  return db.prepare(`
    SELECT user_id, chat_xp, voice_xp, ${expression} AS xp
    FROM users
    WHERE guild_id = ? AND ${expression} > 0
    ORDER BY xp DESC, updated_at ASC, user_id ASC
    LIMIT ? OFFSET ?
  `).all(guildId, limit, offset);
}

export function getLeaderboardCount(guildId, scope = 'all') {
  const expression = scope === 'chat' ? 'chat_xp' : scope === 'voice' ? 'voice_xp' : '(chat_xp + voice_xp)';
  return db.prepare(`SELECT COUNT(*) AS count FROM users WHERE guild_id = ? AND ${expression} > 0`).get(guildId).count;
}

export function getUserRank(guildId, userId, scope = 'all') {
  const expression = scope === 'chat' ? 'chat_xp' : scope === 'voice' ? 'voice_xp' : '(chat_xp + voice_xp)';
  const target = ensureUser(guildId, userId);
  const targetXp = scope === 'chat' ? target.chat_xp : scope === 'voice' ? target.voice_xp : target.chat_xp + target.voice_xp;
  const ahead = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE guild_id = ? AND ${expression} > ?`).get(guildId, targetXp).count;
  return { position: ahead + 1, xp: targetXp };
}

export function getFilterMode(guildId, scope, kind) {
  const row = db.prepare('SELECT mode FROM filter_configs WHERE guild_id = ? AND scope = ? AND kind = ?').get(guildId, scope, kind);
  return row?.mode || 'blacklist';
}

export function setFilterMode(guildId, scope, kind, mode) {
  db.prepare(`
    INSERT INTO filter_configs (guild_id, scope, kind, mode) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, scope, kind) DO UPDATE SET mode = excluded.mode
  `).run(guildId, scope, kind, mode);
}

export function getFilterEntries(guildId, scope, kind) {
  return db.prepare('SELECT target_id FROM filter_entries WHERE guild_id = ? AND scope = ? AND kind = ? ORDER BY created_at ASC').all(guildId, scope, kind).map(row => row.target_id);
}

export function addFilterEntry(guildId, scope, kind, targetId) {
  return db.prepare('INSERT OR IGNORE INTO filter_entries (guild_id, scope, kind, target_id) VALUES (?, ?, ?, ?)').run(guildId, scope, kind, targetId).changes > 0;
}

export function removeFilterEntry(guildId, scope, kind, targetId) {
  return db.prepare('DELETE FROM filter_entries WHERE guild_id = ? AND scope = ? AND kind = ? AND target_id = ?').run(guildId, scope, kind, targetId).changes > 0;
}

export function isMemberExcluded(guildId, userId, scope) {
  return Boolean(db.prepare("SELECT 1 FROM excluded_members WHERE guild_id = ? AND user_id = ? AND scope IN (?, 'all') LIMIT 1").get(guildId, userId, scope));
}

export function setMemberExcluded(guildId, userId, scope, excluded) {
  if (excluded) {
    db.prepare('INSERT OR IGNORE INTO excluded_members (guild_id, user_id, scope) VALUES (?, ?, ?)').run(guildId, userId, scope);
  } else {
    db.prepare('DELETE FROM excluded_members WHERE guild_id = ? AND user_id = ? AND scope = ?').run(guildId, userId, scope);
    db.prepare("DELETE FROM excluded_members WHERE guild_id = ? AND user_id = ? AND scope = 'all'").run(guildId, userId);
    if (scope === 'all') {
      db.prepare('DELETE FROM excluded_members WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
    }
  }
}

export function addAudit(guildId, actorId, action, targetId = null, details = null) {
  db.prepare('INSERT INTO audit_log (guild_id, actor_id, action, target_id, details) VALUES (?, ?, ?, ?, ?)').run(
    guildId, actorId, action, targetId, details == null ? null : String(details).slice(0, 1000)
  );
}

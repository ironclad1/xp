import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const devGuildId = process.env.DEV_GUILD_ID;
if (!token || !clientId || clientId.includes('put_your_')) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env before registering slash commands.');
  process.exit(1);
}

const scopeChoices = [
  { name: 'Combined', value: 'all' },
  { name: 'Chat', value: 'chat' },
  { name: 'Voice', value: 'voice' }
];
const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show the XP bot command list.'),
  new SlashCommandBuilder().setName('rank').setDescription('Show XP, level, and progress for a member.')
    .addUserOption(option => option.setName('user').setDescription('Member to inspect (defaults to you).').setRequired(false)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show combined, chat, or voice XP leaderboard.')
    .addStringOption(option => option.setName('scope').setDescription('Leaderboard type.').setRequired(false).addChoices(...scopeChoices))
    .addIntegerOption(option => option.setName('page').setDescription('Page number.').setRequired(false).setMinValue(1).setMaxValue(10000)),
  new SlashCommandBuilder().setName('settings').setDescription('Open the interactive XP settings panel.'),
  new SlashCommandBuilder().setName('prefix').setDescription('Show or change the server prefix.')
    .addStringOption(option => option.setName('new_prefix').setDescription('New prefix (1–5 characters); leave blank to view.').setRequired(false).setMinLength(1).setMaxLength(5)),
  new SlashCommandBuilder().setName('chatxp').setDescription('Configure chat XP.')
    .addStringOption(option => option.setName('action').setDescription('Open the interactive panel or choose a setting.').setRequired(false).addChoices(
      { name: 'Show settings', value: 'show' }, { name: 'Enable', value: 'on' }, { name: 'Disable', value: 'off' }, { name: 'Toggle', value: 'toggle' },
      { name: 'Set XP range', value: 'range' }, { name: 'Set cooldown', value: 'cooldown' }, { name: 'Set minimum length', value: 'minlength' }
    ))
    .addIntegerOption(option => option.setName('min').setDescription('Minimum XP for range.').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addIntegerOption(option => option.setName('max').setDescription('Maximum XP for range.').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addIntegerOption(option => option.setName('seconds').setDescription('Cooldown in seconds (5–3600).').setRequired(false).setMinValue(5).setMaxValue(3600))
    .addIntegerOption(option => option.setName('characters').setDescription('Minimum message length (1–500).').setRequired(false).setMinValue(1).setMaxValue(500)),
  new SlashCommandBuilder().setName('voicexp').setDescription('Configure voice XP.')
    .addStringOption(option => option.setName('action').setDescription('Open the interactive panel or choose a setting.').setRequired(false).addChoices(
      { name: 'Show settings', value: 'show' }, { name: 'Enable', value: 'on' }, { name: 'Disable', value: 'off' }, { name: 'Toggle', value: 'toggle' },
      { name: 'Set XP range', value: 'range' }, { name: 'Set interval', value: 'interval' }
    ))
    .addIntegerOption(option => option.setName('min').setDescription('Minimum XP for range.').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addIntegerOption(option => option.setName('max').setDescription('Maximum XP for range.').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addIntegerOption(option => option.setName('seconds').setDescription('Interval in seconds (30–3600).').setRequired(false).setMinValue(30).setMaxValue(3600)),
  new SlashCommandBuilder().setName('levelup').setDescription('Configure level-up notifications.')
    .addSubcommand(sub => sub.setName('settings').setDescription('Open interactive level-up settings.'))
    .addSubcommand(sub => sub.setName('show').setDescription('Show level-up settings.'))
    .addSubcommand(sub => sub.setName('enable').setDescription('Enable level-up notifications.'))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable level-up notifications.'))
    .addSubcommand(sub => sub.setName('toggle').setDescription('Toggle level-up notifications.'))
    .addSubcommand(sub => sub.setName('channel').setDescription('Set a fixed notification text channel.')
      .addChannelOption(option => option.setName('channel').setDescription('Channel where level-up notices will be sent.').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
    .addSubcommand(sub => sub.setName('mode').setDescription('Choose automatic, current, system, or DM delivery.')
      .addStringOption(option => option.setName('mode').setDescription('Destination mode.').setRequired(true).addChoices(
        { name: 'Automatic', value: 'auto' }, { name: 'Current channel', value: 'current' },
        { name: 'Server system channel', value: 'system' }, { name: 'DM', value: 'dm' }
      )))
    .addSubcommand(sub => sub.setName('message').setDescription('Set the level-up message template.')
      .addStringOption(option => option.setName('template').setDescription('Use {user}, {level}, {server}, and {xp}.').setRequired(true).setMaxLength(1500))),
  new SlashCommandBuilder().setName('ping').setDescription('Check that the bot responds to slash commands.'),
  new SlashCommandBuilder().setName('filter').setDescription('Configure channel, role, and member XP filters.')
    .addStringOption(option => option.setName('entity').setDescription('What to filter; leave blank for interactive filters.').setRequired(false).addChoices(
      { name: 'Channel', value: 'channel' }, { name: 'Role', value: 'role' }, { name: 'Member', value: 'member' }
    ))
    .addStringOption(option => option.setName('scope').setDescription('XP type. Leave blank for interactive filters.').setRequired(false).addChoices(
      { name: 'Chat', value: 'chat' }, { name: 'Voice', value: 'voice' }, { name: 'All XP (members only)', value: 'all' }
    ))
    .addStringOption(option => option.setName('action').setDescription('Operation; leave blank to open the interactive panel.').setRequired(false).addChoices(
      { name: 'Show list', value: 'list' }, { name: 'Set whitelist mode', value: 'whitelist' }, { name: 'Set blacklist mode', value: 'blacklist' },
      { name: 'Add target', value: 'add' }, { name: 'Remove target', value: 'remove' }, { name: 'Exclude member', value: 'exclude' }, { name: 'Include member', value: 'include' }
    ))
    .addChannelOption(option => option.setName('channel').setDescription('Channel target.').setRequired(false))
    .addRoleOption(option => option.setName('role').setDescription('Role target.').setRequired(false))
    .addUserOption(option => option.setName('user').setDescription('Member target.').setRequired(false)),
  new SlashCommandBuilder().setName('multiplier').setDescription('Configure XP multipliers for channels or roles.')
    .addStringOption(option => option.setName('action').setDescription('Operation; leave blank to open the interactive panel.').setRequired(false).addChoices(
      { name: 'Open interactive manager', value: 'panel' }, { name: 'Show multipliers', value: 'list' }, { name: 'Set multiplier', value: 'set' }, { name: 'Remove multiplier', value: 'remove' }, { name: 'Enable multiplier system', value: 'on' }, { name: 'Disable multiplier system', value: 'off' }, { name: 'Toggle multiplier system', value: 'toggle' }
    ))
    .addStringOption(option => option.setName('target_type').setDescription('Multiplier target type.').setRequired(false).addChoices(
      { name: 'Channel', value: 'channel' }, { name: 'Role', value: 'role' }
    ))
    .addChannelOption(option => option.setName('channel').setDescription('Target channel.').setRequired(false))
    .addRoleOption(option => option.setName('role').setDescription('Target role.').setRequired(false))
    .addNumberOption(option => option.setName('value').setDescription('Multiplier from 0.1 to 5.').setRequired(false).setMinValue(0.1).setMaxValue(5)),
  new SlashCommandBuilder().setName('rewards').setDescription('Configure role rewards for reaching levels.')
    .addStringOption(option => option.setName('action').setDescription('Operation; leave blank to open the interactive panel.').setRequired(false).addChoices(
      { name: 'Show rewards', value: 'list' }, { name: 'Add or update reward', value: 'add' }, { name: 'Remove reward', value: 'remove' }
    ))
    .addIntegerOption(option => option.setName('level').setDescription('Level for the role reward.').setRequired(false).setMinValue(1).setMaxValue(10000))
    .addRoleOption(option => option.setName('role').setDescription('Role to grant.').setRequired(false)),
  new SlashCommandBuilder().setName('xp').setDescription('Manually add, remove, set, or reset member XP.')
    .addStringOption(option => option.setName('action').setDescription('Operation.').setRequired(true).addChoices(
      { name: 'Add XP', value: 'add' }, { name: 'Remove XP', value: 'remove' }, { name: 'Set XP', value: 'set' }, { name: 'Reset XP', value: 'reset' }
    ))
    .addUserOption(option => option.setName('user').setDescription('Member to update.').setRequired(true))
    .addIntegerOption(option => option.setName('amount').setDescription('XP amount, not needed for reset.').setRequired(false).setMinValue(0).setMaxValue(100000000))
    .addStringOption(option => option.setName('scope').setDescription('XP type.').setRequired(false).addChoices(...scopeChoices)),
  new SlashCommandBuilder().setName('resetallxp').setDescription('Reset all chat and voice XP in this server (admin only).')
    .addStringOption(option => option.setName('confirmation').setDescription('This permanently resets XP for this server only.').setRequired(true).addChoices(
      { name: 'Confirm: reset all server XP', value: 'confirm' }
    )),
  new SlashCommandBuilder().setName('diag').setDescription('Check bot permissions and common XP configuration issues.')
];

const rest = new REST({ version: '10' }).setToken(token);
try {
  // Verify that the token and configured Application ID belong to the same bot.
  // This catches a common setup error before commands get registered to the wrong app.
  const botUser = await rest.get(Routes.user());
  console.log(`Token authenticated as ${botUser.username} (${botUser.id}).`);
  if (String(botUser.id) !== String(clientId)) {
    throw new Error(`DISCORD_CLIENT_ID (${clientId}) does not match the bot account ID authenticated by DISCORD_TOKEN (${botUser.id}). Use the Application ID for this exact bot application.`);
  }
  if (devGuildId && !/^\d{15,22}$/.test(devGuildId)) {
    throw new Error('DEV_GUILD_ID must be the numeric ID of the Discord server where you want commands to appear immediately.');
  }
  const body = commands.map(command => command.toJSON());
  const route = devGuildId
    ? Routes.applicationGuildCommands(clientId, devGuildId)
    : Routes.applicationCommands(clientId);
  const result = await rest.put(route, { body });
  console.log(`Registered ${result.length} slash commands ${devGuildId ? `for server ${devGuildId} (guild commands update immediately)` : 'globally (Discord propagation can take time)'}.`);
  console.log(`Commands: ${result.map(command => `/${command.name}`).join(', ')}`);
  if (!devGuildId) console.log('Tip: set DEV_GUILD_ID in .env to your one target server and run this script again for immediate testing.');
} catch (error) {
  console.error('Slash command registration failed. Check the details below:');
  console.error(error?.message || error);
  if (error?.rawError) console.error(JSON.stringify(error.rawError, null, 2));
  process.exit(1);
}

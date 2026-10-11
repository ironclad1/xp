# CV2 XP Bot v1.2.1 — Chat + Voice Leveling

A Discord leveling bot built with **discord.js** and **Discord Components V2 (CV2)**. The main commands are available both as prefix commands and slash commands.

## Features included

- Chat XP across eligible text channels, with configurable random XP, cooldown, minimum message length, and enable/disable switch.
- Voice XP per eligible time interval. By default it requires at least two humans in the channel and skips the server AFK channel and deafened members.
- Combined, chat-only, and voice-only leaderboards, with interactive CV2 buttons for changing leaderboard view and page.
- Rank/profile card showing total XP, chat and voice totals/ranks, level, and progress to the next level.
- CV2 level-up notifications with a per-server on/off setting, destination selection, and template placeholders.
- Channel and role whitelist/blacklist filters, plus per-member chat/voice exclusions.
- Optional channel/role XP multipliers (stacking, capped at ×5).
- Automatic role rewards for reaching configured levels.
- Interactive administrator settings panel with a channel selector for fixed level-up notifications, prefix configuration, manual XP add/remove/set/reset, diagnostics, server-wide XP reset with confirmation, and an audit log of administrative changes. Slash commands are provided for the core settings and administration flows too.
- Permission-aware help: `/help` is private and shows member commands to regular members, while Manage Server users also see admin controls and reset/edit commands. Prefix `!help` stays public and shows only member-safe commands.
- SQLite persistence using a local file, so XP and settings survive process restarts.

## Requirements

- Node.js **22.12+** (the project is configured for this baseline).
- A Discord application/bot in the [Discord Developer Portal](https://discord.com/developers/applications).
- A persistent disk path for `data/xpbot.sqlite` (important on AWS/container hosting).

## Local setup

1. Create an application in the Discord Developer Portal, add a bot, and copy the bot token.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** and **Server Members Intent**. The bot uses message content for prefix commands and member roles for filters/rewards.
3. Copy the application **Application ID** into `DISCORD_CLIENT_ID` in `.env`. For your one-server setup, set `DEV_GUILD_ID` to that Discord server ID so slash commands register there immediately; leave it blank only if you intentionally want global command registration.
4. Invite the bot with the `bot` OAuth2 scope. Recommended permissions:
   - View Channels
   - Send Messages
   - Read Message History
   - Manage Roles (only needed for role rewards; keep the bot's top role above reward roles)
5. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`.
6. Install, register slash commands, check, and start:

   ```bash
   npm install
   npm run register-commands
   npm run check
   npm start
   ```

The database is created automatically at `./data/xpbot.sqlite`. Do not commit `.env` or the database file to a public repository.

## Default rules

- Prefix: `!` (each server can change it independently).
- Chat XP: random **15–25 XP**, once per user per **60 seconds**, with a minimum of **5 non-space characters**.
- Voice XP: random **5–10 XP** each **60-second** eligible interval.
- XP formula: Level `n` starts at `100n + 12.5n(n−1)` total XP. Progress is calculated from combined chat + voice XP.
- Command messages, bot messages, and webhook messages do not award chat XP.
- Voice XP is not awarded when the member is alone, in the server AFK channel, or self/server deafened. Voice XP also obeys voice channel/role/member filters.
- Default filter modes are **blacklist** with empty lists, meaning all channels and roles are allowed unless explicitly excluded.
- Multipliers from a member's roles and the current channel stack and are capped at ×5 overall.

## Prefix command reference

`P` below means the server's current prefix (default `!`). Use `Phelp` to show the prefix command list. The equivalent slash commands are `/help`, `/rank`, `/leaderboard`, `/settings`, `/prefix`, `/chatxp`, `/voicexp`, `/levelup show|enable|disable|toggle|channel|mode|message`, `/filter`, `/multiplier`, `/rewards`, `/xp`, `/resetallxp`, and `/diag`.

### Member commands

| Command | Purpose |
|---|---|
| `!help` | Show public member-safe command help; use `/help` for a private permission-aware view |
| `!ping` | Check bot responsiveness and connected-server count |
| `!ping` | Check bot responsiveness and connected server count |
| `!rank [@user]` | Show a member's XP, level, and progress |
| `!leaderboard [all\|chat\|voice] [page]` | View combined or separate leaderboards; use the buttons for tabs/pages |
| `!prefix` | Show this server's current prefix |

### Server settings — Manage Server permission

| Command | Example / purpose |
|---|---|
| `!settings` | Open the interactive CV2 settings panel; select a text channel in the level-up destination dropdown |
| `!prefix set <prefix>` | `!prefix set ?` |
| `!chatxp on\|off` | Toggle chat XP |
| `!chatxp range <min> <max>` | `!chatxp range 10 25` |
| `!chatxp cooldown <seconds>` | Set the chat XP cooldown (5–3600) |
| `!chatxp minlength <chars>` | Set minimum chat length (1–500) |
| `!voicexp on\|off` | Toggle voice XP |
| `!voicexp range <min> <max>` | `!voicexp range 5 10` |
| `!voicexp interval <seconds>` | Set interval (30–3600 seconds) |
| `!levelup enable` / `!levelup disable` | Explicitly enable/disable notices (also supports `toggle`) |
| `/levelup channel channel:#level-ups` | Slash command to set a fixed destination channel |
| `/levelup show` / `/levelup enable` / `/levelup disable` | Slash-command equivalents for notification settings |
| `/ping` | Confirm that slash interactions are being received and handled |
| `!levelup channel <#channel\|channel-name\|channel-id\|current\|auto\|system\|dm>` | Pick the notice destination; a fixed channel must be sendable by the bot |
| `!levelup show` | Show notification status and the selected destination |
| `!levelup message <template>` | Set text using `{user}`, `{level}`, `{server}`, `{xp}` |
| `!filter channel <chat\|voice> mode <whitelist\|blacklist>` | Set the channel-filter mode |
| `!filter channel <chat\|voice> add <#channel>` | Add a channel to the filter list |
| `!filter channel <chat\|voice> remove <#channel>` | Remove a channel from the filter list |
| `!filter channel <chat\|voice> list` | List channel entries and current mode |
| `!filter role <chat\|voice> mode <whitelist\|blacklist>` | Set the role-filter mode |
| `!filter role <chat\|voice> add <@role>` | Add a role to the filter list |
| `!filter role <chat\|voice> remove <@role>` | Remove a role from the filter list |
| `!filter role <chat\|voice> list` | List role entries and current mode |
| `!filter member <chat\|voice\|all> exclude <@user>` | Exclude a member from XP |
| `!filter member <chat\|voice\|all> include <@user>` | Remove the exclusion |
| `!filter member <chat\|voice\|all> list` | List excluded members |
| `!multiplier channel <#channel> <0.1–5>` | Add/update a channel multiplier |
| `!multiplier role <@role> <0.1–5>` | Add/update a role multiplier |
| `!multiplier remove <channel\|role> <target>` | Remove a multiplier |
| `!multiplier list` | List multipliers |
| `!rewards add <level> <@role>` | Assign a role reward at a level |
| `!rewards remove <level>` | Remove a role reward |
| `!rewards list` | List role rewards |
| `!diag` | Check common permissions/configuration issues |
| `!xp add <@user> <amount> [chat\|voice]` | Add XP |
| `!xp remove <@user> <amount> [chat\|voice]` | Remove XP |
| `!xp set <@user> <amount> [chat\|voice]` | Set a chat or voice XP total |
| `!xp reset <@user> [chat\|voice\|all]` | Reset XP |

The examples use `!`. Replace it with the current server prefix after changing it.

## AWS EC2 deployment (Ubuntu)

EC2 is a straightforward starting point for this always-on gateway bot. The SQLite file must remain on persistent storage, and only one bot process should write to it at a time.

1. Create an Ubuntu EC2 instance. A small instance is usually enough for a modest server, but actual needs depend on guild count and traffic. Restrict inbound SSH to your own IP; the bot does not need an inbound web port.
2. SSH into the instance and install build tools for the SQLite native module:

   ```bash
   sudo apt update
   sudo apt install -y git build-essential python3 make g++
   ```

3. Install Node.js 22.12+ using a trusted Node.js distribution/installation guide for Ubuntu. Verify `node -v` and `npm -v`.
4. Upload/clone this project into `/opt/cv2-xp-bot`, then run:

   ```bash
   cd /opt/cv2-xp-bot
   npm install
   cp .env.example .env
   nano .env
   npm run register-commands
   npm run check
   npm start
   ```

5. For production, run it under `systemd` so the process restarts after a crash or VM reboot. Create `/etc/systemd/system/cv2-xp-bot.service` and adjust `User`, `WorkingDirectory`, and the Node path if needed:

   ```ini
   [Unit]
   Description=Discord CV2 XP Bot
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/opt/cv2-xp-bot
   Environment=NODE_ENV=production
   ExecStart=/usr/bin/node /opt/cv2-xp-bot/src/bot.js
   Restart=always
   RestartSec=5
   KillSignal=SIGINT
   TimeoutStopSec=30

   [Install]
   WantedBy=multi-user.target
   ```

   Check the executable path with `which node`; if Node was installed with `nvm`, point `ExecStart` to that Node binary or use a system-wide installation.

6. Secure the token file and start the service:

   ```bash
   sudo chown -R ubuntu:ubuntu /opt/cv2-xp-bot
   chmod 600 /opt/cv2-xp-bot/.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now cv2-xp-bot
   sudo systemctl status cv2-xp-bot
   journalctl -u cv2-xp-bot -f
   ```

7. Back up `data/xpbot.sqlite` regularly. To move to a different host, stop the service first and copy the database plus any SQLite `-wal`/`-shm` files that still exist, or use SQLite's backup API while running.

### AWS notes

- No custom URL/domain is needed for a normal Discord gateway bot; it makes an outbound persistent connection to Discord. You only need a domain if you later add a website/dashboard or webhook receiver.
- Keep the `.env` file out of GitHub. Consider AWS Systems Manager Parameter Store or Secrets Manager if you prefer centrally managed secrets.
- For high availability or multiple bot replicas, replace local SQLite with a shared database and add a single-writer/leader strategy for voice interval awards. Do not run two copies against the same SQLite file on different EC2 hosts.

## Known first-build limits / next steps

- Slash commands must be registered once with `npm run register-commands`. Global command registration can take time to propagate; set `DEV_GUILD_ID` to your actual server ID to register/replace commands immediately in that server. The registration script prints the bot identity for `DISCORD_TOKEN` and checks it matches `DISCORD_CLIENT_ID`.
- Voice sessions start counting from when the process sees the user in voice. Time while the bot is offline is never backfilled.
- XP is stored separately for chat and voice, while level is derived from the combined total.
- Season resets, prestige, web dashboard, role-removal policies, exports, and cross-server/global leaderboards are not included yet.
- The bot has not been tested against your specific Discord server/token. `npm run check` validates JavaScript syntax; you still need to install dependencies, enable the required gateway intents, and run a live smoke test after inviting it.

## Documentation links

- [Discord Components V2 — official message components guide](https://github.com/discord/discord-api-docs/blob/main/developers/components/using-message-components.mdx)
- [discord.js Components V2 guide](https://discordjs.guide/popular-topics/components-v2)
- [Discord Developer Portal](https://discord.com/developers/applications)


## v1.2.0 — Interactive administration panels

The v1.2.0 update expands the Components V2 settings experience:

- `!settings` opens the home panel with navigation to Chat XP, Voice XP, Level-up, Filters, Multipliers and Rewards.
- `!filter` opens interactive dropdowns for channel, role, or member; chat/voice/all scopes where applicable; whitelist/blacklist behavior; target selectors; and add/remove/include/exclude actions. Direct prefix subcommands remain supported.
- `!chatxp` and `!voicexp` open interactive panels. Buttons toggle XP on/off; modals set XP ranges, chat cooldown/minimum length, and voice interval.
- `!multiplier` opens the multiplier manager. Pick a channel or role, enter a value in a modal, remove existing values, or toggle the multiplier system globally. When the system is off, configured multipliers are retained but not applied.
- `!rewards` opens the rewards manager. Pick a role, enter the award level, or choose a configured level and remove it.
- `!levelup` opens notification settings. Choose automatic/current/system/DM delivery or a fixed text channel. The **Edit level-up message** button opens a form for the message template.
- Slash forms `/filter`, `/chatxp`, `/voicexp`, `/multiplier`, and `/rewards` open their panels when invoked without arguments. `/levelup settings` opens level-up settings.
- Existing databases are migrated automatically to add `multipliers_enabled`; XP rows, prior filters, rewards, and existing settings are retained.

### Updating an existing AWS EC2 deployment

1. Stop the service and back up the database before updating.
2. Upload and extract this ZIP over `/home/ubuntu/cv2-xp-bot/`. The ZIP intentionally does not contain `.env` or a live SQLite database.
3. Run `npm install --no-audit --no-fund`, then `npm run check`.
4. Register the refreshed slash-command definitions with `npm run register-commands`.
5. Start the service again and inspect `sudo journalctl -u cv2-xp-bot -n 50 --no-pager`.

Interactive configuration changes require Manage Server. Awarding reward roles additionally requires Manage Roles and a bot role higher than the role being assigned.

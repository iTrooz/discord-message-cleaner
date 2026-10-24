import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { LOGGER } from './logger.js';

// Load registrations from local persistent storage.
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const token = config.DISCORD_TOKEN;
const appId = config.DISCORD_CLIENT_ID;
if (!token || !appId) throw new Error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in config.json');
const cleanerAdmins = new Set((config.CLEANER_ADMINS || '').split(',').map(id => id.trim()).filter(Boolean));
const deleteDelayMs = config.messageDeleteDelaySeconds * 1000;
const searchDelayMs = config.messageSearchDelaySeconds * 1000;
const botStatus = config.botStatus || 'online';
const botStatusText = config.botStatusText || '';
if (!['online', 'idle', 'dnd', 'invisible'].includes(botStatus)) throw new Error('botStatus must be online, idle, dnd, or invisible');

const dataDir = process.env.DATA_DIR || '.';
mkdirSync(dataDir, { recursive: true });
const file = join(dataDir, 'registrations.json');
// Return an empty registration store on first launch.
const load = () => { try { const saved = JSON.parse(readFileSync(file, 'utf8')); return { ...saved, local: saved.local || {}, global: saved.global || [], metrics: saved.metrics || {}, excluded: saved.excluded || {} }; } catch { return { local: {}, global: [], metrics: {}, excluded: {} }; } };
let data = load();
// Persist registration changes immediately.
const save = () => writeFileSync(file, JSON.stringify(data, null, 2));
const commands = [
  new SlashCommandBuilder().setName('cleaner').setDescription('Manage message cleanup')
    .addSubcommand(s => s.setName('register').setDescription('Register yourself').addStringOption(o => o.setName('scope').setDescription('Where to register').setRequired(true).addChoices({ name: 'This server', value: 'local' }, { name: 'Every server', value: 'global' })))
    .addSubcommand(s => s.setName('unregister').setDescription('Remove your registration').addStringOption(o => o.setName('scope').setDescription('Registration to remove').setRequired(true).addChoices({ name: 'This server', value: 'local' }, { name: 'Every server', value: 'global' })))
    .addSubcommand(s => s.setName('status').setDescription('Show your registrations'))
    .addSubcommand(s => s.setName('run').setDescription('Run cleanup now').addBooleanOption(o => o.setName('older-than-14-days').setDescription('Also delete messages older than 14 days')))
    .addSubcommandGroup(g => g.setName('server').setDescription('Server cleanup settings')
      .addSubcommand(s => s.setName('status').setDescription('Show registrations active in this server'))
      .addSubcommand(s => s.setName('exclude').setDescription('Exclude a channel from cleanup').addChannelOption(o => o.setName('channel').setDescription('Channel to exclude').setRequired(true)))
      .addSubcommand(s => s.setName('include').setDescription('Include a channel in cleanup').addChannelOption(o => o.setName('channel').setDescription('Channel to include').setRequired(true))))
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let lastSearchAt = 0;
let nextCleanId = 0;
client.once('ready', async () => {
  await new REST({ version: '10' }).setToken(token).put(Routes.applicationCommands(appId), { body: commands });
  await client.user.setStatus(botStatus);
  if (botStatusText) await client.user.setActivity(botStatusText);
  LOGGER.info(`Ready as ${client.user.tag}`);
  setInterval(() => sweep().catch(error => LOGGER.error('Scheduled sweep failed', error)), 12 * 60 * 60_000);
  sweep().catch(error => LOGGER.error('Startup sweep failed', error));
});

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand() || i.commandName !== 'cleaner') return;
  const sub = i.options.getSubcommand();
  const group = i.options.getSubcommandGroup();
  const user = i.user.id, guild = i.guildId;
  if (!guild) return i.reply({ content: 'Use this command in a server.', ephemeral: true });
  if (group === 'server' && !cleanerAdmins.has(user)) return i.reply({ content: 'Only configured cleanup admins can use server commands.', ephemeral: true });
  if (!group && sub === 'run') {
    if (!cleanerAdmins.has(user)) return i.reply({ content: 'Only configured cleanup admins can run cleanup.', ephemeral: true });
    if (sweeping) return i.reply({ content: 'A cleanup sweep is already running.', ephemeral: true });
    const includeOlder = i.options.getBoolean('older-than-14-days') || false;
    const run = sweep({ includeOlder });
    await i.reply({ content: `Cleanup sweep started${includeOlder ? ', including messages older than 14 days' : ''}.`, ephemeral: true });
    run.then(async count => {
      const message = `Cleanup sweep finished. Deleted ${count} messages.`;
      try { await i.followUp({ content: message, ephemeral: true }); }
      catch { await i.user.send(message).catch(error => LOGGER.error('Could not send completion DM', error)); }
    }).catch(async error => {
      LOGGER.error('Manual sweep failed', error);
      try { await i.followUp({ content: 'Cleanup sweep failed. Check the bot logs.', ephemeral: true }); }
      catch { await i.user.send('Cleanup sweep failed. Check the bot logs.').catch(dmError => LOGGER.error('Could not send failure DM', dmError)); }
    });
    return;
  }
  if (sub === 'register' || sub === 'unregister') {
    const scope = i.options.getString('scope');
    if (scope === 'global') {
      const has = data.global.includes(user);
      data.global = sub === 'register' ? [...new Set([...data.global, user])] : data.global.filter(id => id !== user);
      await i.reply({ content: sub === 'register' ? 'Global registration saved.' : has ? 'Global registration removed.' : 'You were not registered globally.', ephemeral: true });
    } else {
      data.local[guild] ??= [];
      const has = data.local[guild].includes(user);
      data.local[guild] = sub === 'register' ? [...new Set([...data.local[guild], user])] : data.local[guild].filter(id => id !== user);
      await i.reply({ content: sub === 'register' ? 'Server registration saved.' : has ? 'Server registration removed.' : 'You were not registered here.', ephemeral: true });
    }
    save();
    return;
  }
  if (!group && sub === 'status') {
    const scopes = [data.local[guild]?.includes(user) && 'this server', data.global.includes(user) && 'all servers'].filter(Boolean);
    const counts = data.metrics[user] || { global: 0, guilds: {} };
    const registration = scopes.length ? `Registered for: ${scopes.join(' and ')}.` : 'You have no active registrations.';
    return i.reply({ content: `${registration}\nDeleted messages — this server: ${counts.guilds?.[guild] || 0}; all servers: ${counts.global || 0}.`, ephemeral: true });
  }
  if (group !== 'server') return;
  if (sub === 'exclude' || sub === 'include') {
    const channel = i.options.getChannel('channel');
    if (channel.guildId !== guild) return i.reply({ content: 'Choose a channel from this server.', ephemeral: true });
    data.excluded[guild] ??= [];
    const wasExcluded = data.excluded[guild].includes(channel.id);
    data.excluded[guild] = sub === 'exclude'
      ? [...new Set([...data.excluded[guild], channel.id])]
      : data.excluded[guild].filter(id => id !== channel.id);
    save();
    return i.reply({ content: sub === 'exclude' ? `<#${channel.id}> is excluded from cleanup.` : wasExcluded ? `<#${channel.id}> is included in cleanup.` : `<#${channel.id}> was already included.`, ephemeral: true });
  }
  const ids = [...new Set([...(data.local[guild] || []), ...data.global])];
  const deleted = Object.values(data.metrics).reduce((sum, counts) => sum + (counts.guilds?.[guild] || 0), 0);
  const deletedGlobal = Object.values(data.metrics).reduce((sum, counts) => sum + (counts.global || 0), 0);
  const excluded = data.excluded[guild] || [];
  const status = [
    ids.length ? `Active registrations (${ids.length}): ${ids.map(id => `<@${id}>`).join(', ')}` : 'No active registrations.',
    `Messages deleted in this server: ${deleted}.`,
    `Messages deleted across all servers: ${deletedGlobal}.`,
    `Excluded channels (${excluded.length}): ${excluded.length ? excluded.map(id => `<#${id}>`).join(', ') : 'None.'}`
  ].join('\n');
  return i.reply({ content: status.length <= 2000 ? status : `${status.slice(0, 1990)}…`, ephemeral: true });
});

// Search a guild for messages by the specified registered authors.
async function searchMessages(guildId, authors, bounds, logger) {
  const query = new URLSearchParams({ ...bounds, sort_by: 'timestamp', sort_order: 'asc', limit: '25' });
  for (const author of authors) query.append('author_id', author);
  const wait = searchDelayMs - (Date.now() - lastSearchAt);
  if (lastSearchAt && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastSearchAt = Date.now();
  logger.trace('Message-search request details', { authorIds: authors, bounds });
  logger.debug(`Searching ${authors.length} user(s), after ${bounds.min_id || 'start'}.`);
  const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/messages/search?${query}`, { headers: { Authorization: `Bot ${token}` } });
  logger.trace('Message-search response details', { status: response.status, bounds });
  if (!response.ok) throw new Error(`Message search failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  return (result.messages || []).flat().filter(m => m?.id && m.channel_id && m.author?.id && authors.includes(m.author.id));
}

// Persist one successfully deleted message in the per-user counters.
function recordDeletion(author, guildId) {
  data.metrics[author] ??= { global: 0, guilds: {} };
  data.metrics[author].global++;
  data.metrics[author].guilds[guildId] = (data.metrics[author].guilds[guildId] || 0) + 1;
  save();
}

// Unarchive a thread before trying to delete messages from it.
async function ensureThreadUnarchived(channelId, checkedThreads, archivedThreads, logger) {
  if (checkedThreads.has(channelId)) return;
  const channel = await client.channels.fetch(channelId);
  if (channel?.isThread() && channel.archived) {
    logger.debug(`Unarchiving thread ${channelId} before deletion.`);
    await channel.setArchived(false, 'Cleanup registered messages');
    archivedThreads.set(channelId, channel);
  }
  checkedThreads.add(channelId);
}

// Search registered authors and delete messages in Discord's bulk-delete age window.
async function sweep({ includeOlder = false } = {}) {
  if (sweeping) return;
  sweeping = true;
  const cleanId = nextCleanId++;
  const logger = LOGGER.getSubLogger({ name: `clean/${cleanId}` });
  let deletedCount = 0;
  const sweepDeletions = new Map();
  const checkedThreads = new Set();
  const archivedThreads = new Map();
  logger.info(`Sweep started${includeOlder ? ' with older-than-14-days mode' : ''}.`);
  try {
  const now = Date.now(), lower = BigInt(Math.floor((now - 14 * 864e5 - 1420070400000) * 4194304));
  const upper = BigInt(Math.floor((now - 11 * 864e5 - 1420070400000) * 4194304));
  let lastOldDeletion = 0;
  for (const guild of client.guilds.cache.values()) {
    logger.debug(`Server ID: ${guild.id}`);
    const users = [...new Set([...(data.local[guild.id] || []), ...data.global])];
    const excluded = new Set(data.excluded[guild.id] || []);
    for (let start = 0; start < users.length; start += 100) {
      const authors = users.slice(start, start + 100);
      let cursor = lower;
      while (cursor <= upper) {
        const page = await searchMessages(guild.id, authors, { min_id: String(cursor), max_id: String(upper) }, logger);
        if (!page.length) break;
        const newestId = page.reduce((max, message) => BigInt(message.id) > max ? BigInt(message.id) : max, 0n);
        if (newestId <= cursor) break;
        const found = page.filter(message => BigInt(message.id) >= lower && BigInt(message.id) <= upper && !excluded.has(message.channel_id));
        const counts = Object.groupBy(found, message => message.author.id);
        for (const author of authors) logger.debug(`User ${author} has ${counts[author]?.length || 0} eligible result(s) on this page.`);
        logger.debug(`${found.length} result(s) remain after channel exclusions.`);
        for (const [channel, group] of Object.entries(Object.groupBy(found, message => message.channel_id))) {
          const byId = new Map(group.map(message => [message.id, message.author.id]));
          const eligible = [...byId.keys()];
          for (let n = 0; n < eligible.length; n += 100) {
            const batch = eligible.slice(n, n + 100);
            logger.debug(`Deleting ${batch.length} message(s) from channel ${channel}.`);
            await ensureThreadUnarchived(channel, checkedThreads, archivedThreads, logger);
            if (batch.length === 1) await client.rest.delete(Routes.channelMessage(channel, batch[0]));
            else if (batch.length > 1) await client.rest.post(Routes.channelBulkDelete(channel), { body: { messages: batch } });
            for (const id of batch) {
              const author = byId.get(id);
              recordDeletion(author, guild.id);
              sweepDeletions.set(author, (sweepDeletions.get(author) || 0) + 1);
            }
            deletedCount += batch.length;
            logger.debug(`Deleted ${batch.length} message(s) from channel ${channel}.`);
          }
        }
        cursor = newestId + 1n;
      }
      if (includeOlder) {
        let oldDeleted = 0;
        let oldCursor = null;
        while (oldCursor === null || oldCursor < lower) {
          const bounds = { ...(oldCursor === null ? {} : { min_id: String(oldCursor) }), max_id: String(lower) };
          const page = await searchMessages(guild.id, authors, bounds, logger);
          if (!page.length) break;
          const newestId = page.reduce((max, message) => BigInt(message.id) > max ? BigInt(message.id) : max, 0n);
          const old = page.filter(message => BigInt(message.id) < lower && !excluded.has(message.channel_id));
          logger.debug(`Found ${old.length} older message(s) on this page.`);
          for (const message of old) {
            const wait = deleteDelayMs - (Date.now() - lastOldDeletion);
            if (lastOldDeletion && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
            lastOldDeletion = Date.now();
            try {
              await ensureThreadUnarchived(message.channel_id, checkedThreads, archivedThreads, logger);
              await client.rest.delete(Routes.channelMessage(message.channel_id, message.id));
              recordDeletion(message.author.id, guild.id);
              sweepDeletions.set(message.author.id, (sweepDeletions.get(message.author.id) || 0) + 1);
              deletedCount++;
              oldDeleted++;
              if (oldDeleted % 10 === 0) logger.debug(`Deleted ${oldDeleted} older message(s) so far.`);
            } catch (error) {
              if (error.code === 50021) {
                logger.warn(`Skipping system message ${message.id}; Discord does not allow deleting it.`);
              } else {
                logger.error(`Could not delete old message ${message.id}`, error);
              }
            }
          }
          if (oldCursor !== null && newestId <= oldCursor) break;
          oldCursor = newestId + 1n;
        }
        logger.debug(`Deleted ${oldDeleted} older message(s) in this server.`);
      }
    }
  }
  for (const [author, count] of sweepDeletions) {
    logger.debug(`Sweep total for user ${author}: deleted ${count} message(s).`);
  }
  logger.info(`Sweep finished; deleted ${deletedCount} message(s).`);
  return deletedCount;
  } catch (error) {
    logger.error('Sweep failed', error);
    throw error;
  } finally {
    for (const [channelId, channel] of archivedThreads) {
      try {
        await channel.setArchived(true, 'Cleanup finished');
        logger.debug(`Re-archived thread ${channelId} after cleanup.`);
      } catch (error) {
        logger.error(`Could not re-archive thread ${channelId}`, error);
      }
    }
    sweeping = false;
  }
}

let sweeping = false;
client.login(token);

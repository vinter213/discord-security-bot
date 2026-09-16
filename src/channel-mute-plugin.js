const { setChannelMute, hasSecurityAdminAccess } = require('./channel-mute');


function parseMuteDuration(value) {
  if (value == null || String(value).trim() === '') return null;

  const input = String(value).trim().toLowerCase().replace(/\s+/g, '');
  const match = input.match(/^(\d+)(мин|m|ч|h|д|d)$/u);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return null;

  const unit = match[2];
  const multiplier = unit === 'мин' || unit === 'm'
    ? 60 * 1000
    : unit === 'ч' || unit === 'h'
      ? 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

  const durationMs = amount * multiplier;
  const maxDurationMs = 24 * 24 * 60 * 60 * 1000;
  return durationMs <= maxDurationMs ? durationMs : null;
}

const muteTimers = new Map();

async function handleChannelMuteInteraction(interaction, options) {
  if (!interaction?.guild) return false;
  if (interaction.commandName !== 'mutechat' && interaction.commandName !== 'unmutechat') {
    return false;
  }

  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  if (!hasSecurityAdminAccess(member, options.config)) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({
        content: '❌ Команда доступна только SECURITY ADMIN и OWNER.',
        ephemeral: true
      }).catch(() => {});
    }
    return true;
  }

  const target = interaction.options.getChannel('channel') || interaction.channel;
  if (!target || !options.supportedChannelTypes.has(target.type)) {
    if (typeof interaction.reply === 'function') {
      await interaction.reply({
        content: '❌ Выбери текстовый, новостной или форум-канал.',
        ephemeral: true
      }).catch(() => {});
    }
    return true;
  }

  const enabled = interaction.commandName === 'mutechat';
  const durationInput = enabled && typeof interaction.options.getString === 'function'
    ? interaction.options.getString('time')
    : null;
  const durationMs = durationInput ? parseMuteDuration(durationInput) : null;

  if (enabled && durationInput && durationMs == null) {
    await interaction.reply({
      content: '❌ Неверное время. Примеры: 10мин, 30m, 1ч, 2h, 1д, 7d. Максимум — 24 дня.',
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const reason = `AoS Security: /${interaction.commandName} by ${interaction.user.id}`;

  try {
    await setChannelMute(
      target,
      interaction.guild.roles.everyone,
      enabled,
      reason
    );

    const timerMap = options.timerMap || muteTimers;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const existingTimer = timerMap.get(target.id);

    if (existingTimer) {
      clearTimer(existingTimer);
      timerMap.delete(target.id);
    }

    if (enabled && durationMs != null) {
      const timer = setTimer(async () => {
        try {
          await setChannelMute(
            target,
            interaction.guild.roles.everyone,
            false,
            `AoS Security: automatic unmute after ${durationInput}`
          );
          timerMap.delete(target.id);
          await options.securityLog(
            interaction.guild,
            'AUTO-UNMUTECHAT',
            `${target} автоматически открыт после **${durationInput}**.`
          );
        } catch (error) {
          console.error('[CHANNEL MUTE AUTO-UNMUTE]', error);
          timerMap.delete(target.id);
        }
      }, durationMs);
      timerMap.set(target.id, timer);
      if (typeof timer?.unref === 'function') timer.unref();
    }

    await options.securityLog(
      interaction.guild,
      enabled ? 'MUTECHAT' : 'UNMUTECHAT',
      `<@${interaction.user.id}> ${enabled ? 'закрыл' : 'открыл'} ${target}${enabled && durationInput ? ` на **${durationInput}**` : ''}.`
    );

    await interaction.editReply(
      enabled
        ? durationInput
          ? `🔒 Чат ${target} замучен на **${durationInput}**.`
          : `🔒 Чат ${target} замучен бессрочно.`
        : `🔓 Чат ${target} снова открыт.`
    );
  } catch (error) {
    const code = error?.code || error?.status || 'unknown';
    console.error(`[CHANNEL MUTE] ${interaction.commandName}:`, error);

    if (code === 50013 || code === '50013') {
      await interaction.editReply(
        '❌ У AoS нет прав изменить разрешения этого канала (Missing Permissions / 50013). Проверь права роли AoS Security и её позицию.'
      );
    } else {
      await interaction.editReply(
        `❌ Не удалось изменить чат. Код ошибки: ${code}.`
      );
    }
  }

  return true;
}

function installChannelMutePlugin(discord, env = process.env) {
  const {
    REST,
    Client,
    SlashCommandBuilder,
    ChannelType
  } = discord;

  const splitIds = value => new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );

  const config = {
    ownerUserId: env.OWNER_USER_ID || null,
    ownerRoleIds: splitIds(env.OWNER_ROLE_IDS),
    securityAdminRoleIds: splitIds(env.SECURITY_ADMIN_ROLE_IDS)
  };

  const supportedChannelTypes = new Set([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum
  ]);

  const commandJson = [
    new SlashCommandBuilder()
      .setName('mutechat')
      .setDescription('Закрыть отправку сообщений только в одном канале')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Канал; если не указан — текущий')
          .setRequired(false)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildForum
          )
      )
      .addStringOption(option =>
        option
          .setName('time')
          .setDescription('Время мута: 10мин, 30m, 1ч, 2h, 1д; пусто = бессрочно')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('unmutechat')
      .setDescription('Снова открыть отправку сообщений в одном канале')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Канал; если не указан — текущий')
          .setRequired(false)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.GuildForum
          )
      )
  ].map(command => command.toJSON());

  const securityLog = async (guild, title, description) => {
    console.log(`[SECURITY] ${title}: ${description}`);
    if (!env.SECURITY_LOG_CHANNEL_ID) return;

    const channel = await guild.channels
      .fetch(env.SECURITY_LOG_CHANNEL_ID)
      .catch(() => null);

    if (!channel || !channel.isTextBased?.()) return;

    await channel.send({
      content: `🛡️ **AoS Security — ${title}**\n${description}`,
      allowedMentions: { parse: [] }
    }).catch(error => {
      console.error(`[CHANNEL MUTE LOG] ${error?.code || error?.status || 'unknown'}`);
    });
  };

  const restMarker = Symbol.for('aos.channelMute.restInstalled');
  if (!REST.prototype[restMarker]) {
    const originalPut = REST.prototype.put;
    REST.prototype.put = async function patchedPut(route, requestOptions = {}) {
      let nextOptions = requestOptions;
      const body = requestOptions?.body;

      if (Array.isArray(body)) {
        const names = new Set(body.map(command => command?.name));
        const looksLikeAosRegistration =
          names.has('security-status') &&
          names.has('lockdown') &&
          names.has('panic');

        if (looksLikeAosRegistration) {
          const missingCommands = commandJson.filter(command => !names.has(command.name));
          nextOptions = {
            ...requestOptions,
            body: [...body, ...missingCommands]
          };
        }
      }

      return originalPut.call(this, route, nextOptions);
    };
    REST.prototype[restMarker] = true;
  }

  const clientMarker = Symbol.for('aos.channelMute.clientInstalled');
  if (!Client.prototype[clientMarker]) {
    const originalEmit = Client.prototype.emit;
    Client.prototype.emit = function patchedEmit(eventName, ...args) {
      if (eventName === 'interactionCreate') {
        const interaction = args[0];
        if (
          interaction?.isChatInputCommand?.() &&
          (interaction.commandName === 'mutechat' || interaction.commandName === 'unmutechat')
        ) {
          handleChannelMuteInteraction(interaction, {
            config,
            supportedChannelTypes,
            securityLog,
            timerMap: muteTimers
          }).catch(error => {
            console.error('[CHANNEL MUTE INTERACTION]', error);
          });
        }
      }

      return originalEmit.call(this, eventName, ...args);
    };
    Client.prototype[clientMarker] = true;
  }

  return { commandJson };
}

module.exports = {
  installChannelMutePlugin,
  handleChannelMuteInteraction,
  parseMuteDuration
};
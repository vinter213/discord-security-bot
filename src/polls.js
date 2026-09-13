const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  EmbedBuilder
} = require("discord.js");

const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"],
  ["image/gif", "gif"], ["image/webp", "webp"]
]);

class PollInputError extends Error {}

function commonCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.SendPolls)
    .addStringOption(option => option
      .setName("вопрос").setDescription("Вопрос голосования")
      .setRequired(true).setMinLength(1).setMaxLength(300));
}

function addSettings(command) {
  return command
    .addIntegerOption(option => option
      .setName("часы").setDescription("Срок: 1–768 часов, по умолчанию 24")
      .setMinValue(1).setMaxValue(768))
    .addBooleanOption(option => option
      .setName("мультивыбор").setDescription("Разрешить несколько ответов; по умолчанию один"));
}

function buildPollCommands() {
  const text = commonCommand("poll", "Создать обычное голосование с 2–10 вариантами")
    .addStringOption(option => option
      .setName("варианты").setDescription("От 2 до 10 вариантов через |, например: Да | Нет")
      .setRequired(true).setMinLength(3).setMaxLength(600));
  const photo = commonCommand("poll-photo", "Создать голосование за одну из 2–5 фотографий");
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    photo.addAttachmentOption(option => option
      .setName(`фото${i}`).setDescription(`Фотография ${i}: PNG, JPG, GIF или WebP, до 8 МиБ`)
      .setRequired(i <= 2));
  }
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    photo.addStringOption(option => option
      .setName(`подпись${i}`).setDescription(`Необязательное название фотографии ${i}`)
      .setMinLength(1).setMaxLength(52));
  }
  return [addSettings(text), addSettings(photo)];
}

function cleanText(value, label, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) {
    throw new PollInputError(`${label}: нужно от 1 до ${maxLength} символов.`);
  }
  return text;
}

function photoFile(attachment, slot, uploadLimit) {
  let extension = IMAGE_TYPES.get(attachment.contentType?.split(";")[0].toLowerCase());
  if (!attachment.contentType) {
    extension = /\.(png|jpe?g|gif|webp)$/i.exec(attachment.name || "")?.[1].toLowerCase();
    if (extension === "jpeg") extension = "jpg";
  }
  if (!extension) {
    throw new PollInputError(`Фото ${slot}: прикрепите PNG, JPG, GIF или WebP.`);
  }
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > uploadLimit) {
    throw new PollInputError(`Фото ${slot}: файл должен быть не больше ${Math.floor(uploadLimit / 1024 / 1024)} МиБ.`);
  }
  let url;
  try { url = new URL(attachment.url); } catch {}
  if (!url || url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com" ||
      url.username || url.password || url.port ||
      !/^\/(?:ephemeral-)?attachments\//.test(url.pathname)) {
    throw new PollInputError(`Фото ${slot}: загрузите файл заново через поле команды.`);
  }
  const spoiler = attachment.name?.startsWith("SPOILER_") ? "SPOILER_" : "";
  return {
    attachment: url.href,
    name: `${spoiler}aos-poll-${slot}.${extension}`
  };
}

function buildPollPayload(interaction) {
  const options = interaction.options;
  const question = cleanText(options.getString("вопрос", true), "Вопрос", 300);
  const duration = options.getInteger("часы") ?? 24;
  const allowMultiselect = options.getBoolean("мультивыбор") ?? false;
  if (!Number.isInteger(duration) || duration < 1 || duration > 768) {
    throw new PollInputError("Срок голосования: целое число от 1 до 768 часов.");
  }
  const payload = {
    content: `📊 Голосование от <@${interaction.user.id}>. ${allowMultiselect ? "Можно выбрать несколько вариантов." : "Выберите один вариант."}`,
    allowedMentions: { parse: [] },
    // Discord stores votes and expiry, including while AoS is offline.
    poll: { question: { text: question }, answers: [], duration, allowMultiselect },
    nonce: interaction.id,
    enforceNonce: true
  };

  if (interaction.commandName === "poll") {
    const answers = options.getString("варианты", true).split("|");
    if (answers.length < 2 || answers.length > 10) {
      throw new PollInputError("Введите от 2 до 10 вариантов через |. Например: Да | Нет");
    }
    const texts = answers.map((answer, i) => cleanText(answer, `Вариант ${i + 1}`, 55));
    if (new Set(texts.map(text => text.normalize("NFKC").toLowerCase())).size !== texts.length) {
      throw new PollInputError("Варианты голосования должны отличаться друг от друга.");
    }
    payload.poll.answers = texts.map(text => ({ text }));
    return payload;
  }

  payload.files = [];
  payload.embeds = [];
  let totalBytes = 0;
  let gap = false;
  const uploadLimit = Math.min(MAX_PHOTO_BYTES, interaction.attachmentSizeLimit || MAX_PHOTO_BYTES);
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    const attachment = options.getAttachment(`фото${i}`, i <= 2);
    const caption = options.getString(`подпись${i}`);
    if (!attachment) {
      if (i <= 2) throw new PollInputError("Прикрепите как минимум фото1 и фото2.");
      if (caption !== null && caption !== undefined) {
        throw new PollInputError(`Подпись ${i} указана без фото${i}.`);
      }
      gap = true;
      continue;
    }
    if (gap) throw new PollInputError("Прикрепляйте фотографии по порядку: фото1, фото2, фото3 и так далее.");
    const file = photoFile(attachment, i, uploadLimit);
    totalBytes += attachment.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new PollInputError("Общий размер фотографий — не больше 20 МиБ. Уменьшите изображения.");
    }
    const label = caption == null ? `Фото ${i}` : `${i}. ${cleanText(caption, `Подпись ${i}`, 52)}`;
    file.description = label;
    payload.files.push(file);
    payload.poll.answers.push({ text: label });
    // Re-upload the command attachments so expired source URLs do not break the poll.
    payload.embeds.push(new EmbedBuilder()
      .setColor(0x00D7FF).setTitle(label).setImage(`attachment://${file.name}`));
  }
  payload.content += " Номер варианта соответствует подписи фотографии.";
  return payload;
}

function createPollHandler({ guildId, now = Date.now, logError = console.error }) {
  const cooldowns = new Map();
  return async function handlePoll(interaction) {
    if (!interaction.isChatInputCommand() || !["poll", "poll-photo"].includes(interaction.commandName)) {
      return false;
    }
    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (!interaction.inGuild() || interaction.guildId !== guildId) {
      await reply("Эта команда доступна только на сервере AoS.");
      return true;
    }
    // Text channels and open forum/text threads; announcements do not support polls.
    const channel = interaction.channel;
    const channelTypes = [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread];
    if (!channel || !channelTypes.includes(channel.type) || channel.archived || channel.locked) {
      await reply("Создайте голосование в обычном текстовом канале или открытой ветке.");
      return true;
    }
    const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
    const needed = [PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.SendPolls];
    const photo = interaction.commandName === "poll-photo";
    const memberNeeded = photo ? [...needed, PermissionFlagsBits.AttachFiles] : needed;
    if (interaction.user.bot || !interaction.memberPermissions?.has(memberNeeded)) {
      await reply("Нужны права «Просматривать канал», «Отправлять сообщения» и «Создавать опросы» в этом канале; для фотографий — «Прикреплять файлы».");
      return true;
    }
    const botNeeded = photo ? [...needed, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] : needed;
    if (!interaction.appPermissions?.has(botNeeded)) {
      await reply("Выдайте AoS Security права «Просматривать канал», «Отправлять сообщения» и «Создавать опросы»; для фотографий также «Прикреплять файлы» и «Встраивать ссылки».");
      return true;
    }

    let payload;
    try {
      payload = buildPollPayload(interaction);
    } catch (error) {
      if (!(error instanceof PollInputError)) throw error;
      await reply(error.message);
      return true;
    }
    const time = now();
    for (const [key, expires] of cooldowns) if (expires <= time) cooldowns.delete(key);
    const userKey = `user:${interaction.user.id}`;
    const channelKey = `channel:${interaction.channelId}`;
    const wait = Math.max(cooldowns.get(userKey) || 0, cooldowns.get(channelKey) || 0) - time;
    if (wait > 0) {
      await reply(`Подождите ${Math.ceil(wait / 1000)} сек. перед следующим голосованием.`);
      return true;
    }
    // Reserve before awaiting Discord, so simultaneous commands share the same limit.
    cooldowns.set(userKey, time + 60_000);
    cooldowns.set(channelKey, time + 10_000);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let message;
    try {
      message = await channel.send(payload);
    } catch (error) {
      // No raw API request objects: they may include attachment links and auth details.
      logError(`[POLLS] Create failed: code ${error.code || error.status || "unknown"}`);
      const text = [50001, 50013].includes(Number(error.code))
        ? "Не удалось отправить голосование: проверьте права AoS Security в этом канале."
        : "Discord не подтвердил создание голосования. Проверьте канал перед повтором; если опроса нет, попробуйте через минуту.";
      await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
      return true;
    }
    // A failed private acknowledgement must not cause a second public poll.
    await interaction.editReply({
      content: `✅ Голосование создано: ${message.url}`,
      allowedMentions: { parse: [] }
    }).catch(error => logError(`[POLLS] Confirmation failed: code ${error.code || error.status || "unknown"}`));
    return true;
  };
}

module.exports = { buildPollCommands, buildPollPayload, createPollHandler };

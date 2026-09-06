require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AuditLogEvent,
  ChannelType
} = require("discord.js");

// ============================================================
// CONFIG
// ============================================================

const requiredEnv = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "VERIFIED_ROLE_ID",
  "UNVERIFIED_ROLE_ID"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[ENV] Missing required variable: ${key}`);
    process.exit(1);
  }
}

const CONFIG = {
  guildId: process.env.GUILD_ID,
  verifiedRoleId: process.env.VERIFIED_ROLE_ID,
  unverifiedRoleId: process.env.UNVERIFIED_ROLE_ID,

  verificationChannelId:
    process.env.VERIFICATION_CHANNEL_ID || "1546265698412794037",

  securityLogChannelId:
    process.env.SECURITY_LOG_CHANNEL_ID || null,

  whitelist: new Set(
    (process.env.WHITELIST_USER_IDS || "")
      .split(",")
      .map(v => v.trim())
      .filter(Boolean)
  ),

  ownerUserId:
    process.env.OWNER_USER_ID || null,

  securityAdminRoleIds: new Set(
    (process.env.SECURITY_ADMIN_ROLE_IDS || "")
      .split(",")
      .map(v => v.trim())
      .filter(Boolean)
  ),

  moderatorRoleIds: new Set(
    (process.env.MODERATOR_ROLE_IDS || "")
      .split(",")
      .map(v => v.trim())
      .filter(Boolean)
  ),

  minAccountAgeHours:
    Number(process.env.MIN_ACCOUNT_AGE_HOURS || 24),

  raidJoinLimit:
    Number(process.env.RAID_JOIN_LIMIT || 8),

  raidWindowMs:
    Number(process.env.RAID_WINDOW_SECONDS || 15) * 1000,

  spamMessageLimit:
    Number(process.env.SPAM_MESSAGE_LIMIT || 8),

  spamWindowMs:
    Number(process.env.SPAM_WINDOW_SECONDS || 8) * 1000,

  spamTimeoutMs:
    Number(process.env.SPAM_TIMEOUT_MINUTES || 5) * 60 * 1000,

  nukeActionLimit:
    Number(process.env.NUKE_ACTION_LIMIT || 3),

  nukeWindowMs:
    Number(process.env.NUKE_WINDOW_SECONDS || 10) * 1000
};

const bannerPath = path.join(
  process.cwd(),
  "assets",
  "verification-banner.png"
);

// ============================================================
// HTTP / RENDER
// ============================================================

const app = express();
const PORT = Number(process.env.PORT || 10000);

let discordReady = false;
let raidModeUntil = 0;

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "AoS Security",
    version: "2.0.0",
    discord: discordReady ? "online" : "starting",
    raidMode: Date.now() < raidModeUntil
  });
});

app.get("/health", (_req, res) => {
  if (!discordReady) {
    return res.status(503).json({
      ok: false,
      discord: "not-ready"
    });
  }

  return res.status(200).json({
    ok: true,
    discord: "ready",
    raidMode: Date.now() < raidModeUntil
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Listening on 0.0.0.0:${PORT}`);
});

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution
  ],
  partials: [
    Partials.GuildMember,
    Partials.User,
    Partials.Channel
  ]
});

// ============================================================
// EMBEDS
// ============================================================

function baseEmbed(guild) {
  return new EmbedBuilder()
    .setColor(0x00D7FF)
    .setAuthor({
      name: "AoS Security",
      iconURL: client.user?.displayAvatarURL() || undefined
    })
    .setFooter({
      text: `${guild.name} • Protected by AoS Security`,
      iconURL:
        guild.iconURL({ size: 128 }) ||
        client.user?.displayAvatarURL() ||
        undefined
    })
    .setTimestamp();
}

function verificationEmbed(guild) {
  const embed = baseEmbed(guild)
    .setTitle("🔐 Верификация")
    .setDescription(
      [
        "Для получения доступа к серверу необходимо пройти проверку.",
        "",
        "Нажмите кнопку **«Верифицироваться»** ниже.",
        "",
        "### После успешной проверки",
        "• будет выдана роль **Verified**",
        "• роль **Unverified** будет снята",
        "• откроется доступ к основным каналам",
        "",
        "🛡️ AoS Security автоматически проверяет базовые параметры аккаунта."
      ].join("\n")
    );

  if (guild.iconURL()) {
    embed.setThumbnail(guild.iconURL({ size: 256 }));
  }

  if (fs.existsSync(bannerPath)) {
    embed.setImage("attachment://verification-banner.png");
  }

  return embed;
}

function successEmbed(guild) {
  return baseEmbed(guild)
    .setColor(0x57F287)
    .setTitle("✅ Верификация пройдена")
    .setDescription(
      [
        "Проверка завершена успешно.",
        "",
        "Доступ к серверу открыт.",
        "",
        "Добро пожаловать."
      ].join("\n")
    );
}

function errorEmbed(guild, text) {
  return baseEmbed(guild)
    .setColor(0xED4245)
    .setTitle("⚠️ Проверка не выполнена")
    .setDescription(text);
}

function alertEmbed(guild, title, description) {
  return baseEmbed(guild)
    .setColor(0xED4245)
    .setTitle(`🚨 ${title}`)
    .setDescription(description);
}

function verificationButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("security_verify")
      .setLabel("Верифицироваться")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
  );
}

// ============================================================
// LOGGING
// ============================================================

async function securityLog(guild, title, description) {
  console.log(`[SECURITY] ${title}: ${description}`);

  if (!CONFIG.securityLogChannelId) return;

  const channel = await guild.channels
    .fetch(CONFIG.securityLogChannelId)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) return;

  await channel.send({
    embeds: [alertEmbed(guild, title, description)]
  }).catch(() => {});
}

// ============================================================
// WHITELIST / NEUTRALIZATION
// ============================================================

function isTrusted(guild, userId) {
  if (!userId) return true;
  if (userId === guild.ownerId) return true;
  return CONFIG.whitelist.has(userId);
}

async function neutralizeExecutor(guild, executorId, reason) {
  if (!executorId || isTrusted(guild, executorId)) return false;

  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return false;

  const removableRoles = member.roles.cache.filter(role =>
    role.id !== guild.id &&
    role.editable &&
    role.id !== guild.roles.premiumSubscriberRole?.id
  );

  if (removableRoles.size === 0) {
    await securityLog(
      guild,
      "Не удалось снять роли",
      `<@${executorId}> подозревается в опасной активности, но у AoS Security нет возможности снять его роли.\nПричина: **${reason}**`
    );
    return false;
  }

  await member.roles.remove(
    [...removableRoles.keys()],
    `AoS Security: ${reason}`
  ).catch(() => {});

  await securityLog(
    guild,
    "Пользователь нейтрализован",
    `<@${executorId}> — сняты доступные опасные роли.\nПричина: **${reason}**`
  );

  return true;
}

// ============================================================
// SECURITY COUNTERS
// ============================================================

const joinTimestamps = [];
const spamMap = new Map();
const actionMap = new Map();

function prune(list, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (list.length && list[0] < cutoff) {
    list.shift();
  }
}

function registerSecurityAction(userId, actionName) {
  const key = `${userId}:${actionName}`;

  if (!actionMap.has(key)) {
    actionMap.set(key, []);
  }

  const list = actionMap.get(key);
  list.push(Date.now());
  prune(list, CONFIG.nukeWindowMs);

  return list.length;
}

// ============================================================
// ACCESS CONTROL
// ============================================================

const AccessLevel = Object.freeze({
  MEMBER: 0,
  MODERATOR: 1,
  SECURITY_ADMIN: 2,
  OWNER: 3
});

function getAccessLevel(member) {
  if (!member) return AccessLevel.MEMBER;

  // Discord server owner always gets owner-level access.
  if (member.id === member.guild.ownerId) {
    return AccessLevel.OWNER;
  }

  // Optional explicit AoS owner.
  if (
    CONFIG.ownerUserId &&
    member.id === CONFIG.ownerUserId
  ) {
    return AccessLevel.OWNER;
  }

  const roleIds = new Set(
    member.roles.cache.map(role => role.id)
  );

  for (const roleId of CONFIG.securityAdminRoleIds) {
    if (roleIds.has(roleId)) {
      return AccessLevel.SECURITY_ADMIN;
    }
  }

  for (const roleId of CONFIG.moderatorRoleIds) {
    if (roleIds.has(roleId)) {
      return AccessLevel.MODERATOR;
    }
  }

  return AccessLevel.MEMBER;
}

function accessLevelName(level) {
  switch (level) {
    case AccessLevel.OWNER:
      return "OWNER";
    case AccessLevel.SECURITY_ADMIN:
      return "SECURITY ADMIN";
    case AccessLevel.MODERATOR:
      return "MODERATOR";
    default:
      return "MEMBER";
  }
}

async function requireAccess(
  interaction,
  minimumLevel
) {
  const member = await interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);

  const level = getAccessLevel(member);

  if (level >= minimumLevel) {
    return {
      allowed: true,
      member,
      level
    };
  }

  await interaction.reply({
    ephemeral: true,
    embeds: [
      errorEmbed(
        interaction.guild,
        [
          "У вас нет доступа к этой команде.",
          "",
          `Ваш уровень: **${accessLevelName(level)}**`,
          `Необходимый уровень: **${accessLevelName(minimumLevel)}**`
        ].join("\\n")
      )
    ]
  }).catch(() => {});

  await securityLog(
    interaction.guild,
    "Отказ в доступе",
    `<@${interaction.user.id}> попытался использовать команду \`/${interaction.commandName}\` без нужного уровня доступа.`
  );

  return {
    allowed: false,
    member,
    level
  };
}

// ============================================================
// COMMANDS
// ============================================================

const commands = [
  new SlashCommandBuilder()
    .setName("verification-setup")
    .setDescription("Создать красивую панель верификации"),

  new SlashCommandBuilder()
    .setName("security-status")
    .setDescription("Состояние AoS Security"),

  new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Закрыть или открыть отправку сообщений на сервере")
    .addStringOption(option =>
      option
        .setName("mode")
        .setDescription("Режим")
        .setRequired(true)
        .addChoices(
          { name: "ON", value: "on" },
          { name: "OFF", value: "off" }
        )
    )
    ,

  new SlashCommandBuilder()
    .setName("panic")
    .setDescription("Экстренно закрыть сервер")
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      CONFIG.guildId
    ),
    { body: commands }
  );

  console.log("[COMMANDS] AoS Security commands registered.");
}

// ============================================================
// LOCKDOWN
// ============================================================

async function setLockdown(guild, enabled) {
  const everyone = guild.roles.everyone;

  let changed = 0;

  for (const channel of guild.channels.cache.values()) {
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.GuildForum
    ) {
      continue;
    }

    try {
      await channel.permissionOverwrites.edit(
        everyone,
        {
          SendMessages: enabled ? false : null,
          AddReactions: enabled ? false : null,
          CreatePublicThreads: enabled ? false : null,
          CreatePrivateThreads: enabled ? false : null
        },
        {
          reason: enabled
            ? "AoS Security lockdown"
            : "AoS Security unlock"
        }
      );

      changed++;
    } catch {}
  }

  return changed;
}

// ============================================================
// READY
// ============================================================

client.once("ready", async readyClient => {
  discordReady = true;

  readyClient.user.setPresence({
    activities: [
      {
        name: "🛡️ AoS Security • Protecting server",
        type: 3
      }
    ],
    status: "online"
  });

  console.log(`[DISCORD] Logged in as ${readyClient.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error("[COMMANDS]", error);
  }
});

// ============================================================
// VERIFICATION / ANTI-RAID JOIN
// ============================================================

client.on("guildMemberAdd", async member => {
  if (member.guild.id !== CONFIG.guildId) return;
  if (member.user.bot) return;

  const now = Date.now();

  joinTimestamps.push(now);
  prune(joinTimestamps, CONFIG.raidWindowMs);

  if (joinTimestamps.length >= CONFIG.raidJoinLimit) {
    raidModeUntil = now + 2 * 60 * 1000;

    await securityLog(
      member.guild,
      "Anti-Raid сработал",
      `За короткий промежуток времени обнаружено **${joinTimestamps.length}** входов.\nНовые пользователи остаются в режиме Unverified.`
    );
  }

  const unverifiedRole =
    member.guild.roles.cache.get(CONFIG.unverifiedRoleId);

  if (unverifiedRole) {
    await member.roles.add(
      unverifiedRole,
      "AoS Security: awaiting verification"
    ).catch(() => {});
  }

  const channel = await member.guild.channels
    .fetch(CONFIG.verificationChannelId)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) return;

  const embed = baseEmbed(member.guild)
    .setTitle("🔐 Требуется верификация")
    .setDescription(
      [
        `Добро пожаловать, <@${member.id}>.`,
        "",
        "Перед использованием сервера необходимо пройти **верификацию**.",
        "",
        "Нажмите кнопку ниже."
      ].join("\n")
    )
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }));

  if (fs.existsSync(bannerPath)) {
    embed.setImage("attachment://verification-banner.png");
  }

  const payload = {
    content: `<@${member.id}>`,
    embeds: [embed],
    components: [verificationButtons()],
    allowedMentions: {
      users: [member.id]
    }
  };

  if (fs.existsSync(bannerPath)) {
    payload.files = [
      {
        attachment: bannerPath,
        name: "verification-banner.png"
      }
    ];
  }

  await channel.send(payload).catch(error => {
    console.error("[VERIFY NOTIFY]", error);
  });
});

// ============================================================
// ANTI-SPAM
// ============================================================

client.on("messageCreate", async message => {
  if (!message.guild) return;
  if (message.guild.id !== CONFIG.guildId) return;
  if (message.author.bot) return;

  const member = message.member;
  if (!member) return;

  if (
    isTrusted(message.guild, message.author.id) ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return;
  }

  const now = Date.now();

  if (!spamMap.has(message.author.id)) {
    spamMap.set(message.author.id, []);
  }

  const list = spamMap.get(message.author.id);
  list.push(now);
  prune(list, CONFIG.spamWindowMs);

  const mentionCount =
    message.mentions.users.size +
    message.mentions.roles.size;

  const spamTriggered =
    list.length >= CONFIG.spamMessageLimit ||
    mentionCount >= 6;

  if (!spamTriggered) return;

  await message.delete().catch(() => {});

  if (member.moderatable) {
    await member.timeout(
      CONFIG.spamTimeoutMs,
      "AoS Security Anti-Spam"
    ).catch(() => {});
  }

  spamMap.set(message.author.id, []);

  await securityLog(
    message.guild,
    "Anti-Spam",
    `<@${message.author.id}> превысил лимит сообщений/упоминаний и получил временную блокировку.`
  );
});

// ============================================================
// ANTI-NUKE HELPERS
// ============================================================

async function getRecentAuditEntry(guild, type, targetId = null) {
  const logs = await guild.fetchAuditLogs({
    type,
    limit: 5
  }).catch(() => null);

  if (!logs) return null;

  const now = Date.now();

  for (const entry of logs.entries.values()) {
    if (now - entry.createdTimestamp > 10_000) continue;

    if (
      targetId &&
      entry.targetId &&
      entry.targetId !== targetId
    ) {
      continue;
    }

    return entry;
  }

  return null;
}

async function processDangerousAction(
  guild,
  auditType,
  actionName,
  targetId = null
) {
  const entry = await getRecentAuditEntry(
    guild,
    auditType,
    targetId
  );

  if (!entry?.executorId) return;
  if (isTrusted(guild, entry.executorId)) return;

  const count = registerSecurityAction(
    entry.executorId,
    actionName
  );

  await securityLog(
    guild,
    `Security Event: ${actionName}`,
    `<@${entry.executorId}> выполнил действие **${actionName}**.\nСчётчик: **${count}/${CONFIG.nukeActionLimit}**`
  );

  if (count >= CONFIG.nukeActionLimit) {
    await neutralizeExecutor(
      guild,
      entry.executorId,
      `${actionName}: ${count} действий за короткий период`
    );
  }
}

// ============================================================
// ANTI-NUKE EVENTS
// ============================================================

client.on("channelDelete", async channel => {
  if (!channel.guild || channel.guild.id !== CONFIG.guildId) return;

  await processDangerousAction(
    channel.guild,
    AuditLogEvent.ChannelDelete,
    "CHANNEL_DELETE",
    channel.id
  );
});

client.on("roleDelete", async role => {
  if (role.guild.id !== CONFIG.guildId) return;

  await processDangerousAction(
    role.guild,
    AuditLogEvent.RoleDelete,
    "ROLE_DELETE",
    role.id
  );
});

client.on("guildBanAdd", async ban => {
  if (ban.guild.id !== CONFIG.guildId) return;

  await processDangerousAction(
    ban.guild,
    AuditLogEvent.MemberBanAdd,
    "MEMBER_BAN",
    ban.user.id
  );
});

client.on("webhooksUpdate", async channel => {
  if (!channel.guild || channel.guild.id !== CONFIG.guildId) return;

  // WebhooksUpdate сам по себе не говорит, что именно произошло.
  // Проверяем последние webhook-события.
  for (const type of [
    AuditLogEvent.WebhookCreate,
    AuditLogEvent.WebhookDelete,
    AuditLogEvent.WebhookUpdate
  ]) {
    const entry = await getRecentAuditEntry(
      channel.guild,
      type
    );

    if (!entry?.executorId) continue;
    if (isTrusted(channel.guild, entry.executorId)) return;

    const count = registerSecurityAction(
      entry.executorId,
      "WEBHOOK_CHANGE"
    );

    await securityLog(
      channel.guild,
      "Webhook изменён",
      `<@${entry.executorId}> изменил webhook.\nСчётчик: **${count}/${CONFIG.nukeActionLimit}**`
    );

    if (count >= CONFIG.nukeActionLimit) {
      await neutralizeExecutor(
        channel.guild,
        entry.executorId,
        "Массовые изменения webhook"
      );
    }

    break;
  }
});

// ============================================================
// INTERACTIONS
// ============================================================

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "verification-setup") {
        const access = await requireAccess(
          interaction,
          AccessLevel.SECURITY_ADMIN
        );

        if (!access.allowed) return;

        const payload = {
          embeds: [verificationEmbed(interaction.guild)],
          components: [verificationButtons()]
        };

        if (fs.existsSync(bannerPath)) {
          payload.files = [
            {
              attachment: bannerPath,
              name: "verification-banner.png"
            }
          ];
        }

        await interaction.reply({
          content: "✅ Панель AoS Security создана.",
          ephemeral: true
        });

        await interaction.channel.send(payload);
        return;
      }

      if (interaction.commandName === "security-status") {
        const access = await requireAccess(
          interaction,
          AccessLevel.MODERATOR
        );

        if (!access.allowed) return;

        const verifiedRole =
          interaction.guild.roles.cache.get(
            CONFIG.verifiedRoleId
          );

        const unverifiedRole =
          interaction.guild.roles.cache.get(
            CONFIG.unverifiedRoleId
          );

        await interaction.reply({
          ephemeral: true,
          embeds: [
            baseEmbed(interaction.guild)
              .setTitle("🛡️ AoS Security Status")
              .setDescription(
                [
                  `Discord: **${discordReady ? "ONLINE ✅" : "OFFLINE ❌"}**`,
                  `Verification: **ENABLED ✅**`,
                  `Anti-Spam: **ENABLED ✅**`,
                  `Anti-Raid: **ENABLED ✅**`,
                  `Anti-Nuke: **ENABLED ✅**`,
                  `Raid Mode: **${Date.now() < raidModeUntil ? "ACTIVE 🚨" : "NORMAL ✅"}**`,
                  `Ваш уровень доступа: **${accessLevelName(access.level)}**`,
                  "",
                  `Verified role: ${verifiedRole ? "✅" : "❌"}`,
                  `Unverified role: ${unverifiedRole ? "✅" : "❌"}`
                ].join("\n")
              )
          ]
        });

        return;
      }

      if (interaction.commandName === "lockdown") {
        const access = await requireAccess(
          interaction,
          AccessLevel.SECURITY_ADMIN
        );

        if (!access.allowed) return;

        const mode = interaction.options.getString(
          "mode",
          true
        );

        await interaction.deferReply({
          ephemeral: true
        });

        const enabled = mode === "on";
        const changed = await setLockdown(
          interaction.guild,
          enabled
        );

        await securityLog(
          interaction.guild,
          enabled ? "LOCKDOWN" : "UNLOCK",
          `<@${interaction.user.id}> переключил режим.\nИзменено каналов: **${changed}**`
        );

        await interaction.editReply(
          enabled
            ? `🔒 Lockdown включён. Изменено каналов: ${changed}`
            : `🔓 Lockdown отключён. Изменено каналов: ${changed}`
        );

        return;
      }

      if (interaction.commandName === "panic") {
        const access = await requireAccess(
          interaction,
          AccessLevel.SECURITY_ADMIN
        );

        if (!access.allowed) return;

        await interaction.deferReply({
          ephemeral: true
        });

        raidModeUntil =
          Date.now() + 10 * 60 * 1000;

        const changed = await setLockdown(
          interaction.guild,
          true
        );

        await securityLog(
          interaction.guild,
          "PANIC MODE",
          `<@${interaction.user.id}> включил экстренный режим.\nLockdown каналов: **${changed}**`
        );

        await interaction.editReply(
          `🚨 PANIC MODE активирован. Сервер закрыт. Изменено каналов: ${changed}`
        );

        return;
      }
    }

    if (
      interaction.isButton() &&
      interaction.customId === "security_verify"
    ) {
      if (!interaction.inGuild()) return;

      await interaction.deferReply({
        ephemeral: true
      });

      const member =
        await interaction.guild.members.fetch(
          interaction.user.id
        );

      const verifiedRole =
        interaction.guild.roles.cache.get(
          CONFIG.verifiedRoleId
        );

      const unverifiedRole =
        interaction.guild.roles.cache.get(
          CONFIG.unverifiedRoleId
        );

      if (!verifiedRole || !unverifiedRole) {
        await interaction.editReply({
          embeds: [
            errorEmbed(
              interaction.guild,
              "Роли верификации настроены неправильно. Обратитесь к администрации."
            )
          ]
        });

        return;
      }

      if (
        member.roles.cache.has(
          verifiedRole.id
        )
      ) {
        await interaction.editReply({
          embeds: [
            successEmbed(interaction.guild)
              .setDescription(
                "Вы уже прошли верификацию."
              )
          ]
        });

        return;
      }

      const minimumAgeMs =
        CONFIG.minAccountAgeHours *
        60 *
        60 *
        1000;

      const accountAge =
        Date.now() -
        interaction.user.createdTimestamp;

      if (accountAge < minimumAgeMs) {
        await interaction.editReply({
          embeds: [
            errorEmbed(
              interaction.guild,
              `Аккаунт Discord должен быть старше **${CONFIG.minAccountAgeHours} часов**.`
            )
          ]
        });

        return;
      }

      await member.roles.add(
        verifiedRole,
        "AoS Security verification passed"
      );

      if (
        member.roles.cache.has(
          unverifiedRole.id
        )
      ) {
        await member.roles.remove(
          unverifiedRole,
          "AoS Security verification passed"
        );
      }

      await interaction.editReply({
        embeds: [
          successEmbed(interaction.guild)
        ]
      });

      await securityLog(
        interaction.guild,
        "Верификация",
        `<@${interaction.user.id}> успешно прошёл верификацию.`
      );
    }
  } catch (error) {
    console.error("[INTERACTION]", error);

    if (interaction.isRepliable()) {
      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction.editReply({
          content:
            "⚠️ AoS Security: произошла ошибка."
        }).catch(() => {});
      } else {
        await interaction.reply({
          content:
            "⚠️ AoS Security: произошла ошибка.",
          ephemeral: true
        }).catch(() => {});
      }
    }
  }
});

// ============================================================
// ERRORS / SHUTDOWN
// ============================================================

client.on("error", error => {
  console.error("[DISCORD CLIENT ERROR]", error);
});

process.on("unhandledRejection", error => {
  console.error("[UNHANDLED REJECTION]", error);
});

async function shutdown(signal) {
  console.log(
    `[SYSTEM] ${signal} received. Shutting down...`
  );

  discordReady = false;

  try {
    client.destroy();
  } catch {}

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () =>
  shutdown("SIGTERM")
);

process.on("SIGINT", () =>
  shutdown("SIGINT")
);

client.login(process.env.DISCORD_TOKEN)
  .catch(error => {
    console.error("[DISCORD] Login failed:", error);
    process.exit(1);
  });

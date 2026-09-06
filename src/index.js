require("dotenv").config();

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
  EmbedBuilder
} = require("discord.js");

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

const app = express();
const PORT = Number(process.env.PORT || 10000);

let discordReady = false;

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "discord-security-bot",
    status: discordReady ? "online" : "starting"
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
    discord: "ready"
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Listening on 0.0.0.0:${PORT}`);
});

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
  partials: [Partials.GuildMember, Partials.User]
});

const commands = [
  new SlashCommandBuilder()
    .setName("verification-setup")
    .setDescription("Создать панель верификации")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("security-status")
    .setDescription("Показать состояние Security Bot")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );

  console.log("[COMMANDS] Guild slash commands registered.");
}

client.once("ready", async readyClient => {
  discordReady = true;

  console.log(`[DISCORD] Logged in as ${readyClient.user.tag}`);
  console.log(`[DISCORD] Guilds: ${readyClient.guilds.cache.size}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error("[COMMANDS] Failed to register commands:", error);
  }
});

client.on("guildMemberAdd", async member => {
  if (member.guild.id !== process.env.GUILD_ID) return;
  if (member.user.bot) return;

  const role = member.guild.roles.cache.get(process.env.UNVERIFIED_ROLE_ID);

  if (!role) {
    console.warn("[VERIFY] Unverified role not found.");
    return;
  }

  try {
    await member.roles.add(role, "New member awaiting verification");
    console.log(`[VERIFY] ${member.user.tag} -> Unverified`);
  } catch (error) {
    console.error("[VERIFY] Failed to assign Unverified role:", error);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "verification-setup") {
        const embed = new EmbedBuilder()
          .setTitle("🔐 Верификация")
          .setDescription(
            [
              "Для получения доступа к серверу нажмите кнопку ниже.",
              "",
              "После проверки вам будет выдана роль участника."
            ].join("\n")
          );

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("security_verify")
            .setLabel("Верифицироваться")
            .setEmoji("✅")
            .setStyle(ButtonStyle.Success)
        );

        await interaction.reply({
          content: "Панель верификации создана.",
          ephemeral: true
        });

        await interaction.channel.send({
          embeds: [embed],
          components: [row]
        });

        return;
      }

      if (interaction.commandName === "security-status") {
        const guild = interaction.guild;

        const verifiedRole =
          guild.roles.cache.get(process.env.VERIFIED_ROLE_ID);
        const unverifiedRole =
          guild.roles.cache.get(process.env.UNVERIFIED_ROLE_ID);

        await interaction.reply({
          ephemeral: true,
          content: [
            "🛡️ **Security Bot**",
            `Discord connection: ${discordReady ? "✅ ONLINE" : "❌ OFFLINE"}`,
            `Verified role: ${verifiedRole ? "✅" : "❌"}`,
            `Unverified role: ${unverifiedRole ? "✅" : "❌"}`,
            "Verification module: ✅ ENABLED"
          ].join("\n")
        });

        return;
      }
    }

    if (interaction.isButton() && interaction.customId === "security_verify") {
      if (!interaction.inGuild()) return;

      await interaction.deferReply({ ephemeral: true });

      const member = await interaction.guild.members.fetch(interaction.user.id);

      const verifiedRole =
        interaction.guild.roles.cache.get(process.env.VERIFIED_ROLE_ID);

      const unverifiedRole =
        interaction.guild.roles.cache.get(process.env.UNVERIFIED_ROLE_ID);

      if (!verifiedRole || !unverifiedRole) {
        await interaction.editReply(
          "Ошибка конфигурации ролей. Обратитесь к администрации."
        );
        return;
      }

      if (member.roles.cache.has(verifiedRole.id)) {
        await interaction.editReply("Вы уже прошли верификацию.");
        return;
      }

      // Базовая проверка возраста аккаунта.
      const accountAgeMs = Date.now() - interaction.user.createdTimestamp;
      const minimumAgeMs = 24 * 60 * 60 * 1000;

      if (accountAgeMs < minimumAgeMs) {
        await interaction.editReply(
          "⚠️ Аккаунт создан менее 24 часов назад. Автоматическая верификация временно недоступна."
        );
        return;
      }

      await member.roles.add(verifiedRole, "Verification passed");

      if (member.roles.cache.has(unverifiedRole.id)) {
        await member.roles.remove(unverifiedRole, "Verification passed");
      }

      await interaction.editReply(
        "✅ Верификация пройдена. Доступ к серверу открыт."
      );
    }
  } catch (error) {
    console.error("[INTERACTION]", error);

    if (interaction.isRepliable()) {
      const payload = {
        content: "Произошла ошибка Security Bot.",
        ephemeral: true
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

client.on("error", error => {
  console.error("[DISCORD CLIENT ERROR]", error);
});

process.on("unhandledRejection", error => {
  console.error("[UNHANDLED REJECTION]", error);
});

async function shutdown(signal) {
  console.log(`[SYSTEM] ${signal} received. Shutting down...`);

  discordReady = false;

  try {
    client.destroy();
  } catch {}

  server.close(() => {
    console.log("[HTTP] Server closed.");
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error("[DISCORD] Login failed:", error);
  process.exit(1);
});

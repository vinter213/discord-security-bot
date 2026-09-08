"use strict";

// Uses the discord.js Message/GuildMember interfaces. No login is needed to test it.
function createAntiSpam({ client, config, isTrusted, log, now = Date.now }) {
  const states = new Map();
  const cooldownMs = Math.max(30_000, config.spamWindowMs);
  const maxPending = 100;

  for (const [name, value, min, max] of [
    ["SPAM_MESSAGE_LIMIT", config.spamMessageLimit, 2, 100],
    ["SPAM_WINDOW_SECONDS", config.spamWindowMs / 1000, 1, 300],
    ["SPAM_TIMEOUT_MINUTES", config.spamTimeoutMs / 60_000, 1, 40_320]
  ]) {
    if (!Number.isFinite(value) || value < min || value > max || !Number.isInteger(value)) {
      throw new Error(`${name}: требуется целое число от ${min} до ${max}`);
    }
  }

  // Do not print Discord request objects: they may contain credentials/webhook tokens.
  function apiError(error) {
    const code = error?.code ?? error?.status;
    if (Number(code) === 50013) return "Discord 50013: недостаточно прав или роль AoS ниже цели";
    if (Number(code) === 50001) return "Discord 50001: нет доступа";
    if (Number(code) === 10007) return "Discord 10007: участник уже отсутствует на сервере";
    if (Number(code) === 10015) return "Discord 10015: вебхук уже отсутствует";
    return /^\d+$/.test(String(code)) ? `Discord: код ${code}` : "ошибка запроса к Discord";
  }

  async function report(guild, title, description) {
    try {
      await log(guild, title, description);
    } catch {
      console.error(`[ANTI-SPAM] Не удалось отправить лог: ${title}; ${description}`);
    }
  }

  async function stopSender(message) {
    if (message.webhookId) {
      try {
        const hook = await message.fetchWebhook();
        const channelId = message.channel.isThread?.()
          ? message.channel.parentId : message.channel.id;
        if (hook.guildId !== message.guild.id || hook.channelId !== channelId) {
          return { stopped: false, text: "Вебхук не удалён: не подтверждён сервер/канал" };
        }
        // Only incoming webhooks; application/follower webhooks need a different action.
        if (hook.type !== 1) {
          return { stopped: false, text: "Источник не отключён: это вебхук приложения/подписки. Удаление его сообщений продолжается" };
        }
        await hook.delete("AoS Security Anti-Spam");
        return { stopped: true, text: "Спамящий входящий вебхук удалён" };
      } catch (error) {
        return { stopped: false, text: `Вебхук не отключён: ${apiError(error)}. Нужно право «Управлять вебхуками»` };
      }
    }

    let member;
    try {
      member = message.member || await message.guild.members.fetch(message.author.id);
    } catch (error) {
      return { stopped: false, text: `Не удалось получить участника: ${apiError(error)}` };
    }
    if (!member) return { stopped: false, text: "Участник не найден; удаление сообщений продолжается" };

    if (message.author.bot) {
      let banFailure = "нет права «Банить участников» или роль AoS не выше роли цели";
      if (member.bannable) {
        try {
          // Clean only the observed spam below; do not purge unrelated historical messages.
          await member.ban({ reason: "AoS Security Anti-Spam", deleteMessageSeconds: 0 });
          return { stopped: true, text: "Спамящий бот забанен" };
        } catch (error) {
          banFailure = apiError(error);
        }
      }
      if (member.kickable) {
        try {
          await member.kick("AoS Security Anti-Spam: ban unavailable");
          return { stopped: true, text: `Бот исключён без бана. Бан не выполнен: ${banFailure}` };
        } catch (error) {
          banFailure += `; исключение: ${apiError(error)}`;
        }
      }
      return { stopped: false, text: `Бот НЕ остановлен: ${banFailure}. Подними роль AoS выше роли этого бота` };
    }

    // Preserve the existing exemption for human administrators, including uncached members.
    if (member.permissions.has("Administrator")) return { exempt: true };
    if (!member.moderatable) {
      return { stopped: false, text: "Таймаут НЕ выдан: проверь право «Модерировать участников» и порядок ролей" };
    }
    try {
      await member.timeout(config.spamTimeoutMs, "AoS Security Anti-Spam");
      return { stopped: true, text: `Участнику выдан таймаут на ${config.spamTimeoutMs / 60_000} мин.` };
    } catch (error) {
      return { stopped: false, text: `Таймаут НЕ выдан: ${apiError(error)}` };
    }
  }

  async function cleanMessages(messages) {
    const channels = new Map();
    let deleted = 0;
    const failures = new Set();
    for (const message of messages) {
      if (!message.deletable) {
        failures.add(`канал ${message.channel.id}: нет права удалять сообщения`);
        continue;
      }
      if (!channels.has(message.channel)) channels.set(message.channel, []);
      channels.get(message.channel).push(message);
    }
    for (const [channel, batch] of channels) {
      try {
        if (batch.length > 1 && typeof channel.bulkDelete === "function") {
          const result = await channel.bulkDelete(batch.map(message => message.id), true);
          deleted += result.size;
        } else {
          for (const message of batch) {
            try {
              await message.delete();
              deleted++;
            } catch (error) {
              if (Number(error?.code) !== 10008) failures.add(apiError(error));
            }
          }
        }
      } catch (error) {
        failures.add(`канал ${channel.id}: ${apiError(error)}`);
      }
    }
    return { deleted, failures: [...failures] };
  }

  const sweep = setInterval(() => {
    const cutoff = now() - cooldownMs;
    for (const [key, state] of states) {
      if (!state.running && state.lastSeen < cutoff) states.delete(key);
    }
  }, 60_000);
  sweep.unref();

  async function handle(message) {
    if (!message.guild || message.guild.id !== config.guildId || !message.author) return;
    if (message.author.id === client.user?.id) return;
    if (!message.webhookId && isTrusted(message.guild, message.author.id)) return;
    if (!message.webhookId && !message.author.bot && message.member?.permissions.has("Administrator")) return;

    const key = `${message.guild.id}:${message.webhookId ? "webhook" : "user"}:${message.webhookId || message.author.id}`;
    const timestamp = now();
    let state = states.get(key);
    if (!state) {
      state = { entries: [], pending: new Map(), lastSeen: timestamp, activeUntil: 0,
        nextActionAt: 0, nextLogAt: 0, running: false, dropped: 0 };
      states.set(key, state);
    }
    state.lastSeen = timestamp;
    const cutoff = timestamp - config.spamWindowMs;
    state.entries = state.entries.filter(entry => entry.at > cutoff);
    const everyone = !!message.mentions?.everyone;
    state.entries.push({ at: timestamp, everyone });
    if (state.entries.length > maxPending) state.entries.shift();

    if (!state.running && timestamp >= state.activeUntil) {
      for (const [id, item] of state.pending) {
        if (item.at <= cutoff) state.pending.delete(id);
      }
    }
    state.pending.set(message.id, { at: timestamp, message });
    if (state.pending.size > maxPending) {
      state.pending.delete(state.pending.keys().next().value);
      state.dropped++;
    }

    const mentionCount = (message.mentions?.users.size || 0) + (message.mentions?.roles.size || 0);
    const triggered = state.entries.length >= config.spamMessageLimit || mentionCount >= 6 ||
      state.entries.filter(entry => entry.everyone).length >= 2;
    if (!triggered && timestamp >= state.activeUntil) return;
    state.activeUntil = timestamp + cooldownMs;
    if (state.running) return;

    // The lock is acquired before any await. One sanction/cleanup worker per sender.
    state.running = true;
    try {
      do {
        let outcome;
        if (now() >= state.nextActionAt) {
          state.nextActionAt = now() + cooldownMs;
          outcome = await stopSender(message);
          if (outcome.exempt) {
            states.delete(key);
            return;
          }
        }
        const batch = [...state.pending.values()].map(item => item.message);
        state.pending.clear();
        const cleanup = await cleanMessages(batch);
        if (outcome || ((cleanup.failures.length || state.dropped) && now() >= state.nextLogAt)) {
          state.nextLogAt = now() + cooldownMs;
          const sender = message.webhookId ? `Вебхук ${message.webhookId}` : `<@${message.author.id}>`;
          const details = [sender, outcome?.text, `Удалено сообщений в этой партии: ${cleanup.deleted}.`,
            ...cleanup.failures.slice(0, 5),
            state.dropped ? `Очередь переполнена: ${state.dropped} сообщений не попали в очистку.` : null]
            .filter(Boolean).join("\n");
          state.dropped = 0;
          await report(message.guild, outcome?.stopped ? "Anti-Spam: источник остановлен" : "Anti-Spam: требуется внимание", details);
        }
        // Messages arriving during Discord requests are collected and cleaned in the next batch.
      } while (state.pending.size);
    } catch (error) {
      await report(message.guild, "Anti-Spam: ошибка обработки", apiError(error));
    } finally {
      state.running = false;
    }
  }

  handle.dispose = () => { clearInterval(sweep); states.clear(); };
  return handle;
}

module.exports = { createAntiSpam };

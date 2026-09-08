"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAntiSpam } = require("../src/anti-spam");

function fixture(t, options = {}) {
  let time = 100_000;
  let sequence = 0;
  const calls = { bans: [], kicks: [], timeouts: [], deleted: [], logs: [], hooks: [] };
  const member = {
    user: { id: "sender", bot: options.bot ?? true },
    permissions: { has: permission => permission === "Administrator" && !!options.admin },
    bannable: options.bannable ?? true,
    kickable: options.kickable ?? false,
    moderatable: options.moderatable ?? true,
    async ban(args) {
      calls.bans.push(args);
      if (options.banWait) await options.banWait;
      if (options.banError) throw options.banError;
    },
    async kick(reason) { calls.kicks.push(reason); },
    async timeout(ms) {
      calls.timeouts.push(ms);
      if (options.timeoutError) throw options.timeoutError;
    }
  };
  const guild = { id: "aos", ownerId: "owner", members: { fetch: async () => member } };
  const channels = new Map();
  function channel(id) {
    if (!channels.has(id)) channels.set(id, {
      id,
      async bulkDelete(ids) {
        if (options.deleteWait) await options.deleteWait;
        if (options.deleteError) throw options.deleteError;
        calls.deleted.push(...ids);
        return new Map(ids.map(id => [id, true]));
      }
    });
    return channels.get(id);
  }
  const config = { guildId: "aos", spamMessageLimit: 8, spamWindowMs: 8000, spamTimeoutMs: 300_000, ...options.config };
  const handler = createAntiSpam({
    client: { user: { id: "security" } }, config, now: () => time,
    isTrusted: (_guild, id) => id === "owner" || id === "trusted",
    log: async (_guild, title, description) => { calls.logs.push({ title, description }); }
  });
  t.after(() => handler.dispose());
  function message(overrides = {}) {
    const id = `m${++sequence}`;
    return {
      id, guild, member: options.uncached ? null : member, author: member.user,
      channel: channel("chat"), deletable: options.deletable ?? true,
      mentions: { users: new Map(), roles: new Map(), everyone: false },
      async delete() {
        if (options.deleteError) throw options.deleteError;
        calls.deleted.push(id);
      },
      ...overrides
    };
  }
  async function send(count, overrides = {}) {
    for (let i = 0; i < count; i++) await handler(message(overrides));
  }
  return { handler, calls, message, send, channel, advance: ms => { time += ms; } };
}

for (const admin of [false, true]) {
  test(`spam from ${admin ? "administrator" : "ordinary"} bot is banned and the whole burst is deleted`, async t => {
    const f = fixture(t, { admin });
    await f.send(7);
    assert.equal(f.calls.bans.length, 0);
    assert.equal(f.calls.deleted.length, 0);
    await f.send(1);
    assert.equal(f.calls.bans.length, 1);
    assert.equal(f.calls.bans[0].deleteMessageSeconds, 0);
    assert.equal(f.calls.deleted.length, 8);
    assert.equal(f.calls.timeouts.length, 0);
    assert.match(f.calls.logs[0].description, /бот забанен/);
  });
}

test("one sender flooding several channels hits a server-wide limit", async t => {
  const f = fixture(t);
  await f.send(4, { channel: f.channel("one") });
  await f.send(4, { channel: f.channel("two") });
  assert.equal(f.calls.bans.length, 1);
  assert.equal(new Set(f.calls.deleted).size, 8);
});

test("slow messages and different authors do not combine into a false positive", async t => {
  const f = fixture(t);
  await f.send(7);
  f.advance(8001);
  await f.send(7);
  await f.send(7, { author: { id: "someone-else", bot: true } });
  assert.equal(f.calls.bans.length, 0);
  assert.equal(f.calls.deleted.length, 0);
});

test("self, explicit whitelist, human administrator, DMs and other guilds are ignored", async t => {
  const f = fixture(t);
  for (const id of ["security", "owner", "trusted"]) {
    await f.send(9, { author: { id, bot: true } });
  }
  await f.send(9, { guild: null });
  await f.send(9, { guild: { id: "other" } });
  assert.equal(f.calls.bans.length, 0);
  assert.equal(f.calls.deleted.length, 0);
  const human = fixture(t, { bot: false, admin: true });
  await human.send(9);
  assert.equal(human.calls.timeouts.length, 0);
  assert.equal(human.calls.deleted.length, 0);
});

test("humans still receive a timeout; a missing member cache does not bypass protection", async t => {
  const human = fixture(t, { bot: false, uncached: true });
  await human.send(8);
  assert.deepEqual(human.calls.timeouts, [300_000]);
  assert.equal(human.calls.bans.length, 0);
  const bot = fixture(t, { uncached: true });
  await bot.send(8);
  assert.equal(bot.calls.bans.length, 1);
});

test("unavailable bans fall back to kick; high roles produce an honest failure log", async t => {
  const kick = fixture(t, { bannable: false, kickable: true });
  await kick.send(8);
  assert.equal(kick.calls.kicks.length, 1);
  assert.match(kick.calls.logs[0].description, /исключён без бана/);
  const blocked = fixture(t, { bannable: false, kickable: false });
  await blocked.send(12);
  assert.equal(blocked.calls.bans.length, 0);
  assert.equal(blocked.calls.timeouts.length, 0);
  assert.equal(blocked.calls.deleted.length, 12);
  assert.equal(blocked.calls.logs.length, 1);
  assert.match(blocked.calls.logs[0].description, /НЕ остановлен/);
});

test("Discord API failures never claim a successful ban, timeout or deletion", async t => {
  const denied = { code: 50013, requestBody: { token: "SECRET_SHOULD_NOT_LEAK" } };
  const bot = fixture(t, { banError: denied, deleteError: denied });
  await bot.send(8);
  assert.equal(bot.calls.deleted.length, 0);
  assert.match(bot.calls.logs[0].description, /НЕ остановлен/);
  assert.match(bot.calls.logs[0].description, /50013/);
  assert.doesNotMatch(JSON.stringify(bot.calls.logs), /SECRET_SHOULD_NOT_LEAK|бот забанен/);
  const human = fixture(t, { bot: false, timeoutError: denied });
  await human.send(8);
  assert.match(human.calls.logs[0].description, /Таймаут НЕ выдан/);
});

test("six distinct mentions or two everyone/here pings trigger protection", async t => {
  const mentions = fixture(t);
  await mentions.send(1, { mentions: { users: new Map([["1", 1], ["2", 2], ["3", 3]]), roles: new Map([["4", 4], ["5", 5], ["6", 6]]), everyone: false } });
  assert.equal(mentions.calls.bans.length, 1);
  const everyone = fixture(t);
  await everyone.send(1, { mentions: { users: new Map(), roles: new Map(), everyone: true } });
  assert.equal(everyone.calls.bans.length, 0);
  await everyone.send(1, { mentions: { users: new Map(), roles: new Map(), everyone: true } });
  assert.equal(everyone.calls.bans.length, 1);
});

test("incoming webhook flood is disabled without relying on message.member", async t => {
  const f = fixture(t);
  const hook = { type: 1, guildId: "aos", channelId: "chat", delete: async () => f.calls.hooks.push("hook") };
  await f.send(8, { webhookId: "hook", member: null, fetchWebhook: async () => hook });
  assert.deepEqual(f.calls.hooks, ["hook"]);
  assert.equal(f.calls.deleted.length, 8);
  assert.equal(f.calls.bans.length, 0);
});

test("unmanageable webhook is reported and its observed messages are still removed", async t => {
  const f = fixture(t);
  await f.send(8, { webhookId: "hook", member: null, fetchWebhook: async () => { throw { code: 50013 }; } });
  assert.match(f.calls.logs[0].description, /Вебхук не отключён/);
  assert.equal(f.calls.deleted.length, 8);
});

test("simultaneous events cause a single ban and include messages arriving during the ban", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { banWait: gate });
  await f.send(7);
  const incident = f.handler(f.message());
  const more = [];
  for (let i = 0; i < 40; i++) more.push(f.handler(f.message()));
  await Promise.all(more);
  assert.equal(f.calls.bans.length, 1);
  release();
  await incident;
  assert.equal(new Set(f.calls.deleted).size, 48);
  assert.equal(f.calls.bans.length, 1);
});

test("messages arriving during cleanup are not stranded in the queue", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { deleteWait: gate });
  await f.send(7);
  const incident = f.handler(f.message());
  // Let the sanction finish and the first deletion batch begin.
  await new Promise(resolve => setImmediate(resolve));
  await f.send(5);
  release();
  await incident;
  assert.equal(new Set(f.calls.deleted).size, 13);
  assert.equal(f.calls.bans.length, 1);
});

test("failed sanctions are retried after cooldown without resetting flood protection", async t => {
  const f = fixture(t, { banError: { code: 50013 } });
  await f.send(12);
  assert.equal(f.calls.bans.length, 1);
  f.advance(30_001);
  await f.send(8);
  assert.equal(f.calls.bans.length, 2);
});

test("queue overflow is bounded and explicitly reported", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { banWait: gate });
  await f.send(7);
  const incident = f.handler(f.message());
  await f.send(140);
  release();
  await incident;
  assert.equal(f.calls.deleted.length, 100);
  assert.match(f.calls.logs[0].description, /Очередь переполнена: 48/);
});

test("invalid thresholds fail explicitly instead of disabling detection", () => {
  for (const limit of [NaN, 0, -2, 1.5, 101]) {
    assert.throws(() => createAntiSpam({ config: { spamMessageLimit: limit, spamWindowMs: 8000, spamTimeoutMs: 300_000 } }), /SPAM_MESSAGE_LIMIT/);
  }
});

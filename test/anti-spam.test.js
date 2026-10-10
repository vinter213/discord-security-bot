"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAntiSpam } = require("../src/anti-spam");

function fixture(t, options = {}) {
  let time = 100_000;
  let seq = 0;
  const calls = { timeouts: [], bans: [], kicks: [], deleted: [], logs: [], hooks: [] };
  const member = {
    user: { id: "sender", bot: options.bot ?? true },
    permissions: { has: permission => permission === "Administrator" && !!options.admin },
    moderatable: options.moderatable ?? !options.admin,
    bannable: options.bannable ?? true,
    kickable: options.kickable ?? false,
    async timeout(ms, reason) {
      calls.timeouts.push({ ms, reason });
      if (options.timeoutWait) await options.timeoutWait;
      if (options.timeoutError) throw options.timeoutError;
    },
    async ban(args) {
      calls.bans.push(args);
      if (options.banWait) await options.banWait;
      if (options.banError) throw options.banError;
    },
    async kick() { calls.kicks.push(true); if (options.kickError) throw options.kickError; }
  };
  const guild = { id: "aos", ownerId: "owner", members: { fetch: async () => member } };
  const channels = new Map();
  function channel(id = "chat") {
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
  const config = {
    guildId: "aos",
    spamMessageLimit: 5,
    spamWindowMs: 5_000,
    spamTimeoutMs: 30 * 60_000,
    ...options.config
  };
  const handler = createAntiSpam({
    client: { user: { id: "security" } },
    config,
    now: () => time,
    isTrusted: (_guild, id) => id === "owner" || id === "trusted",
    log: async (_guild, title, description) => calls.logs.push({ title, description })
  });
  t.after(() => handler.dispose());
  function message(overrides = {}) {
    const id = `m${++seq}`;
    return {
      id, guild, member: options.uncached ? null : member, author: member.user,
      channel: channel(), deletable: options.deletable ?? true,
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

test("human: 5 messages within 5 seconds yield 30-minute timeout", async t => {
  const f = fixture(t, { bot: false, uncached: true });
  await f.send(4);
  assert.equal(f.calls.timeouts.length, 0);
  f.advance(4_999);
  await f.send(1);
  assert.deepEqual(f.calls.timeouts.map(x => x.ms), [1_800_000]);
  assert.equal(f.calls.deleted.length, 5);
  assert.equal(f.calls.bans.length, 0);
});
for (const admin of [false, true]) {
  test(`bot with Administrator=${admin}: 5 messages yield ban, not timeout`, async t => {
    const f = fixture(t, { admin, uncached: true });
    await f.send(4);
    assert.equal(f.calls.bans.length, 0);
    f.advance(4_999);
    await f.send(1);
    assert.equal(f.calls.bans.length, 1);
    assert.equal(f.calls.bans[0].deleteMessageSeconds, 0);
    assert.equal(f.calls.timeouts.length, 0);
    assert.equal(f.calls.deleted.length, 5);
  });
}
test("4 messages in a 5-second window never trigger a timeout", async t => {
  const f = fixture(t);
  await f.send(4);
  f.advance(5_001);
  await f.send(1);
  assert.equal(f.calls.timeouts.length, 0);
  assert.equal(f.calls.deleted.length, 0);
});

test("messages from the same bot across channels count toward one server-wide limit", async t => {
  const f = fixture(t);
  await f.send(2, { channel: f.channel("first") });
  await f.send(3, { channel: f.channel("second") });
  assert.equal(f.calls.bans.length, 1);
  assert.equal(new Set(f.calls.deleted).size, 5);
});

test("different users, whitelist, AoS itself, DMs and other guilds are exempt", async t => {
  const f = fixture(t);
  for (const id of ["security", "owner", "trusted"]) {
    await f.send(6, { author: { id, bot: true } });
  }
  await f.send(6, { guild: null });
  await f.send(6, { guild: { id: "other" } });
  assert.equal(f.calls.timeouts.length, 0);
  const humanAdmin = fixture(t, { bot: false, admin: true });
  await humanAdmin.send(6);
  assert.equal(humanAdmin.calls.timeouts.length, 0);
  const separate = fixture(t);
  await separate.send(4);
  await separate.send(4, { author: { id: "another", bot: true } });
  assert.equal(separate.calls.timeouts.length, 0);
});

test("bot ban fails: kick is used when available", async t => {
  const f = fixture(t, { bannable: false, kickable: true });
  await f.send(5);
  assert.equal(f.calls.kicks.length, 1);
  assert.equal(f.calls.timeouts.length, 0);
});
test("bot with role too high is logged, but spam is deleted", async t => {
  const f = fixture(t, { bannable: false, kickable: false });
  await f.send(5);
  assert.equal(f.calls.bans.length, 0);
  assert.equal(f.calls.deleted.length, 5);
  assert.match(f.calls.logs[0].description, /НЕ остановлен/);
});
test("failed Discord ban is not logged as successful", async t => {
  const f = fixture(t, { banError: { code: 50013 } });
  await f.send(5);
  assert.equal(f.calls.bans.length, 1);
  assert.match(f.calls.logs[0].description, /50013/);
  assert.doesNotMatch(f.calls.logs[0].description, /бот забанен/);
});
test("mention flood protections remain operational", async t => {
  const f = fixture(t);
  await f.send(1, { mentions: {
    users: new Map([["1", 1], ["2", 2], ["3", 3]]),
    roles: new Map([["4", 4], ["5", 5], ["6", 6]]),
    everyone: false
  } });
  assert.equal(f.calls.bans.length, 1);
  const e = fixture(t);
  const ping = { mentions: { users: new Map(), roles: new Map(), everyone: true } };
  await e.send(1, ping);
  assert.equal(e.calls.timeouts.length, 0);
  await e.send(1, ping);
  assert.equal(e.calls.bans.length, 1);
});

test("incoming webhook spam is deleted and its webhook disabled", async t => {
  const f = fixture(t);
  const hook = { type: 1, guildId: "aos", channelId: "chat", delete: async () => f.calls.hooks.push("deleted") };
  await f.send(5, { webhookId: "hook", member: null, fetchWebhook: async () => hook });
  assert.deepEqual(f.calls.hooks, ["deleted"]);
  assert.equal(f.calls.deleted.length, 5);
  assert.equal(f.calls.timeouts.length, 0);
});

test("unmanageable incoming webhook is reported and its observed messages cleaned", async t => {
  const f = fixture(t);
  await f.send(5, { webhookId: "hook", member: null, fetchWebhook: async () => { throw { code: 50013 }; } });
  assert.match(f.calls.logs[0].description, /Вебхук не отключён/);
  assert.equal(f.calls.deleted.length, 5);
});

test("concurrent messages produce only one ban and include arrivals during API wait", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { banWait: gate });
  await f.send(4);
  const incident = f.handler(f.message());
  const others = [];
  for (let i = 0; i < 40; i++) others.push(f.handler(f.message()));
  await Promise.all(others);
  assert.equal(f.calls.bans.length, 1);
  release();
  await incident;
  assert.equal(new Set(f.calls.deleted).size, 45);
  assert.equal(f.calls.bans.length, 1);
});

test("failed bans are retried after cooldown if spam continues", async t => {
  const f = fixture(t, { banError: { code: 50013 } });
  await f.send(8);
  assert.equal(f.calls.bans.length, 1);
  f.advance(30_001);
  await f.send(5);
  assert.equal(f.calls.bans.length, 2);
});

test("large simultaneous flood is bounded, and overflow is logged", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { banWait: gate });
  await f.send(4);
  const incident = f.handler(f.message());
  await f.send(140);
  release();
  await incident;
  assert.equal(f.calls.deleted.length, 100);
  assert.match(f.calls.logs[0].description, /Очередь переполнена: 45/);
});

test("invalid thresholds fail explicitly", () => {
  for (const limit of [NaN, 0, -2, 1.5, 101]) {
    assert.throws(() => createAntiSpam({
      config: { spamMessageLimit: limit, spamWindowMs: 5_000, spamTimeoutMs: 1_800_000 }
    }), /SPAM_MESSAGE_LIMIT/);
  }
});

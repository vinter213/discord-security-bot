const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const discord = require("discord.js");
const { Client, MessagePayload, PermissionsBitField, PermissionFlagsBits: P, ChannelType, MessageFlags } = discord;
const { buildPollCommands, buildPollPayload, createPollHandler } = require("../src/polls");

const guildId = "111111111111111111";
const defaults = { вопрос: "Когда играем?", варианты: "Сегодня | Завтра" };
const all = [P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.SendPolls, P.AttachFiles, P.EmbedLinks];
let sequence = 0;

function attachment(overrides = {}) {
  return {
    name: "picture.png", contentType: "image/png", size: 200,
    url: "https://cdn.discordapp.com/attachments/123/456/picture.png?ex=123&hm=abc",
    ...overrides
  };
}

function interaction(values = {}, commandName = "poll") {
  const options = { ...defaults, ...values };
  const calls = { replies: [], edits: [], sent: [], events: [] };
  const result = {
    id: String(155555555555555555n + BigInt(++sequence)), guildId,
    channelId: "222222222222222222", user: { id: "333333333333333333", bot: false },
    commandName, memberPermissions: new PermissionsBitField(all), appPermissions: new PermissionsBitField(all),
    isChatInputCommand: () => true, inGuild: () => true,
    options: Object.fromEntries(["getString", "getInteger", "getBoolean", "getAttachment"].map(name =>
      [name, key => options[key] ?? null])),
    reply: async payload => { calls.replies.push(payload); },
    deferReply: async payload => { calls.events.push("defer"); calls.deferred = payload; },
    editReply: async payload => { calls.edits.push(payload); },
    channel: {
      type: ChannelType.GuildText, isThread: () => false,
      send: async payload => {
        calls.events.push("send"); calls.sent.push(payload);
        return { url: "https://discord.com/channels/111/222/444" };
      }
    }, calls
  };
  return result;
}

test("slash command registration uses valid required attachment and text options", () => {
  const commands = buildPollCommands().map(command => command.toJSON());
  assert.deepEqual(commands.map(command => command.name), ["poll", "poll-photo"]);
  for (const command of commands) {
    assert.equal(command.default_member_permissions, P.SendPolls.toString());
    let optional = false;
    for (const option of command.options) {
      if (!option.required) optional = true;
      else assert.equal(optional, false, "Discord requires mandatory options first");
    }
  }
  assert.deepEqual(commands[1].options.filter(option => option.required).map(option => option.name),
    ["вопрос", "фото1", "фото2"]);
});

test("text poll serializes to Discord API format without enabling mentions", () => {
  const input = interaction({ вопрос: " @everyone Когда? ", варианты: " Сейчас | Потом ", часы: 3, мультивыбор: true });
  const client = new Client({ intents: [] });
  const { body } = new MessagePayload({ client }, buildPollPayload(input)).resolveBody();
  assert.equal(body.poll.question.text, "@everyone Когда?");
  assert.deepEqual(body.poll.answers.map(answer => answer.poll_media.text), ["Сейчас", "Потом"]);
  assert.equal(body.poll.duration, 3);
  assert.equal(body.poll.allow_multiselect, true);
  assert.deepEqual(body.allowed_mentions.parse, []);
  assert.equal(body.nonce, input.id);
  assert.equal(body.enforce_nonce, true);
  client.destroy();
});

test("rejects invalid question, duplicate or empty answers and out-of-range durations", () => {
  for (const values of [
    { вопрос: "  " }, { вопрос: "x".repeat(301) }, { варианты: "Один" },
    { варианты: "Да | да" }, { варианты: "Да |  " }, { варианты: "Да || Нет" },
    { варианты: Array.from({ length: 11 }, (_, i) => String(i)).join("|") },
    { варианты: `Да|${"x".repeat(56)}` }, { часы: 0 }, { часы: 769 }, { часы: 1.5 }
  ]) assert.throws(() => buildPollPayload(interaction(values)));
  const valid = buildPollPayload(interaction({ варианты: Array.from({ length: 10 }, (_, i) => String(i)).join("|") }));
  assert.equal(valid.poll.answers.length, 10);
  assert.equal(valid.poll.duration, 24);
  assert.equal(valid.poll.allowMultiselect, false);
});

test("photos are re-uploaded with distinct filenames and match numbered poll answers", async () => {
  const input = interaction({ фото1: attachment(), фото2: attachment(), подпись1: "Красная форма" }, "poll-photo");
  const payload = buildPollPayload(input);
  assert.equal(payload.files[0].attachment, attachment().url);
  assert.notEqual(payload.files[0].name, payload.files[1].name);
  assert.equal(payload.poll.answers[0].text, "1. Красная форма");
  assert.equal(payload.poll.answers[1].text, "Фото 2");
  const client = new Client({ intents: [] });
  // Resolve multipart data locally; no Discord request or CDN download.
  for (const file of payload.files) file.attachment = Buffer.from("local-test-image");
  const message = new MessagePayload({ client }, payload).resolveBody();
  await message.resolveFiles();
  for (let i = 0; i < 2; i++) {
    assert.equal(message.body.embeds[i].image.url, `attachment://${message.files[i].name}`);
    assert.equal(message.body.embeds[i].title, message.body.poll.answers[i].poll_media.text);
    assert.equal(message.body.attachments[i].description, message.body.poll.answers[i].poll_media.text);
  }
  assert.equal(message.body.poll.allow_multiselect, false);
  client.destroy();
});

test("five photos fit; incomplete or oversized image selections fail before sending", () => {
  const photos = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`фото${i + 1}`, attachment()]));
  assert.equal(buildPollPayload(interaction(photos, "poll-photo")).poll.answers.length, 5);
  for (const overrides of [
    { фото1: null }, { фото3: null }, { подпись5: "x".repeat(53) },
    { фото1: attachment({ contentType: "application/pdf" }) },
    { фото1: attachment({ size: 9 * 1024 * 1024 }) },
    { фото1: attachment({ url: "http://127.0.0.1/private.png" }) },
    { фото1: attachment({ url: "https://cdn.discordapp.com.evil.test/attachments/1/2/a.png" }) }
  ]) assert.throws(() => buildPollPayload(interaction({ ...photos, ...overrides }, "poll-photo")));
  const tooLarge = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`фото${i + 1}`, attachment({ size: 5 * 1024 * 1024 })]));
  assert.throws(() => buildPollPayload(interaction(tooLarge, "poll-photo")), /20 МиБ/);
  assert.throws(() => buildPollPayload(interaction({ фото1: attachment(), фото2: attachment(), подпись3: "Без фото" }, "poll-photo")), /без фото3/);
});

test("unrelated security commands and verification buttons pass to existing handlers", async () => {
  const handler = createPollHandler({ guildId });
  const unrelated = interaction({}, "security-status");
  assert.equal(await handler(unrelated), false);
  unrelated.isChatInputCommand = () => false;
  unrelated.commandName = "poll";
  assert.equal(await handler(unrelated), false);
  assert.equal(unrelated.calls.replies.length, 0);
});

test("unauthorized member cannot use bot permissions to create polls or bypass lockdown", async () => {
  for (const missing of [P.SendPolls, P.SendMessages, P.ViewChannel]) {
    const input = interaction();
    input.memberPermissions.remove(missing);
    assert.equal(await createPollHandler({ guildId })(input), true);
    assert.equal(input.calls.sent.length, 0);
    assert.equal(input.calls.replies[0].flags, MessageFlags.Ephemeral);
  }
});

test("missing photo permissions are reported before an upload", async () => {
  for (const [actor, permission] of [["memberPermissions", P.AttachFiles], ["appPermissions", P.AttachFiles], ["appPermissions", P.EmbedLinks], ["appPermissions", P.SendPolls]]) {
    const input = interaction({ фото1: attachment(), фото2: attachment() }, "poll-photo");
    input[actor].remove(permission);
    await createPollHandler({ guildId })(input);
    assert.equal(input.calls.sent.length, 0);
    assert.equal(input.calls.replies.length, 1);
  }
});

test("wrong server, DMs, announcements and closed threads do not publish polls", async () => {
  for (const change of [
    input => { input.guildId = "another-guild"; },
    input => { input.inGuild = () => false; },
    input => { input.channel.type = ChannelType.GuildAnnouncement; },
    input => { input.channel.archived = true; },
    input => { input.channel.locked = true; }
  ]) {
    const input = interaction(); change(input);
    await createPollHandler({ guildId })(input);
    assert.equal(input.calls.sent.length, 0);
    assert.equal(input.calls.replies.length, 1);
  }
});

test("open threads use SendMessagesInThreads, including forum posts", async () => {
  const input = interaction();
  input.channel.type = ChannelType.PublicThread;
  input.channel.isThread = () => true;
  input.appPermissions.remove(P.SendMessages);
  input.memberPermissions.remove(P.SendMessages);
  await createPollHandler({ guildId })(input);
  assert.equal(input.calls.sent.length, 1);
  const denied = interaction();
  denied.channel.type = ChannelType.PublicThread;
  denied.channel.isThread = () => true;
  denied.memberPermissions.remove(P.SendMessagesInThreads);
  await createPollHandler({ guildId })(denied);
  assert.equal(denied.calls.sent.length, 0);
});

test("simultaneous commands share the user cooldown before the first API response", async () => {
  const handler = createPollHandler({ guildId, now: () => 1000 });
  const first = interaction();
  const second = interaction({ фото1: attachment(), фото2: attachment() }, "poll-photo");
  second.channelId = "other-channel";
  await Promise.all([handler(first), handler(second)]);
  assert.equal(first.calls.sent.length + second.calls.sent.length, 1);
  assert.match(second.calls.replies[0].content, /60 сек/);
  assert.deepEqual(first.calls.events, ["defer", "send"]);
  assert.match(first.calls.edits[0].content, /Голосование создано/);
});

test("channel cooldown limits different users; the original user can publish after expiry", async () => {
  let time = 1000;
  const handler = createPollHandler({ guildId, now: () => time });
  await handler(interaction());
  const nextUser = interaction(); nextUser.user.id = "444444444444444444";
  await handler(nextUser);
  assert.match(nextUser.calls.replies[0].content, /10 сек/);
  time += 60_000;
  const again = interaction();
  await handler(again);
  assert.equal(again.calls.sent.length, 1);
});

test("invalid input does not consume the creation cooldown", async () => {
  const handler = createPollHandler({ guildId });
  const invalid = interaction({ варианты: "Да | Да" });
  await handler(invalid);
  assert.equal(invalid.calls.sent.length, 0);
  const valid = interaction();
  await handler(valid);
  assert.equal(valid.calls.sent.length, 1);
});

test("API errors do not claim success or expose request details", async () => {
  for (const code of [50013, "ECONNRESET"]) {
    const input = interaction();
    input.channel.send = async () => { throw { code, requestBody: { token: "private-test-data" } }; };
    const logs = [];
    await createPollHandler({ guildId, logError: line => logs.push(line) })(input);
    assert.doesNotMatch(input.calls.edits[0].content, /✅|Голосование создано/);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes("private-test-data"));
  }
});

test("failed private confirmation never re-sends a created poll", async () => {
  const input = interaction(); const logs = [];
  input.editReply = async () => { throw { code: 10062 }; };
  assert.equal(await createPollHandler({ guildId, logError: line => logs.push(line) })(input), true);
  assert.equal(input.calls.sent.length, 1);
  assert.match(logs[0], /Confirmation failed/);
});

test("application startup registers all six commands and routes polls through the real integration", async () => {
  let client; let registration;
  class OfflineClient extends EventEmitter {
    constructor() { super(); client = this; this.user = { setPresence() {}, displayAvatarURL() {}, tag: "Offline" }; }
    login() { return Promise.resolve(); }
  }
  class OfflineREST {
    setToken() { return this; }
    async put(route, data) { registration = { route, ...data }; }
  }
  const env = Object.fromEntries(["DISCORD_TOKEN", "CLIENT_ID", "VERIFIED_ROLE_ID", "UNVERIFIED_ROLE_ID"].map(key => [key, "offline-test"]));
  env.GUILD_ID = guildId;
  const code = fs.readFileSync(require.resolve("../src/index"), "utf8");
  const sandbox = {
    require(name) {
      if (name === "discord.js") return { ...discord, Client: OfflineClient, REST: OfflineREST };
      if (name === "dotenv") return { config() {} };
      if (name === "express") return () => ({ get() {}, listen() { return { close() {} }; } });
      if (name === "./polls") return require("../src/polls");
      if (name === "./anti-spam") return { createAntiSpam: () => () => {} };
      if (name === "../package.json") return require("../package.json");
      return require(name);
    },
    process: { env, cwd: () => "/offline", on() {}, exit() { assert.fail("startup exited"); } },
    console: { log() {}, error: (...args) => assert.fail(String(args)) },
    setTimeout
  };
  vm.runInNewContext(code, sandbox, { filename: "src/index.js" });
  await client.listeners("ready")[0](client);
  assert.deepEqual(Array.from(registration.body, command => command.name),
    ["verification-setup", "security-status", "lockdown", "panic", "poll", "poll-photo"]);
  const input = interaction();
  await client.listeners("interactionCreate")[0](input);
  assert.equal(input.calls.sent.length, 1);
});

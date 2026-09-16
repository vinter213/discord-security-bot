const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../src/channel-mute-plugin');

test('parses Russian and compact mute durations', () => {
  assert.equal(plugin.parseMuteDuration?.('10мин'), 10 * 60 * 1000);
  assert.equal(plugin.parseMuteDuration?.('30m'), 30 * 60 * 1000);
  assert.equal(plugin.parseMuteDuration?.('2ч'), 2 * 60 * 60 * 1000);
  assert.equal(plugin.parseMuteDuration?.('1д'), 24 * 60 * 60 * 1000);
});

test('rejects invalid or excessive mute durations', () => {
  assert.equal(plugin.parseMuteDuration?.('abc'), null);
  assert.equal(plugin.parseMuteDuration?.('0мин'), null);
  assert.equal(plugin.parseMuteDuration?.('31д'), null);
});

class FakeOption {
  constructor() { this.data = {}; }
  setName(value) { this.data.name = value; return this; }
  setDescription(value) { this.data.description = value; return this; }
  setRequired(value) { this.data.required = value; return this; }
  addChannelTypes(...values) { this.data.channel_types = values; return this; }
}

class FakeBuilder {
  constructor() { this.data = { options: [] }; }
  setName(value) { this.data.name = value; return this; }
  setDescription(value) { this.data.description = value; return this; }
  addChannelOption(callback) {
    const option = callback(new FakeOption());
    this.data.options.push(option.data);
    return this;
  }
  addStringOption(callback) {
    const option = callback(new FakeOption());
    this.data.options.push(option.data);
    return this;
  }
  toJSON() { return structuredClone(this.data); }
}

class FakeREST { async put(_route, options) { return options.body; } }
class FakeClient { emit() {} }

test('mutechat registration exposes optional time string option', () => {
  const result = plugin.installChannelMutePlugin({
    REST: FakeREST,
    Client: FakeClient,
    SlashCommandBuilder: FakeBuilder,
    ChannelType: { GuildText: 0, GuildAnnouncement: 5, GuildForum: 15 }
  }, {});

  const mute = result.commandJson.find(command => command.name === 'mutechat');
  const time = mute.options.find(option => option.name === 'time');
  assert.ok(time);
  assert.equal(time.required, false);
});

test('timed mute schedules automatic unmute for the selected channel', async () => {
  const edits = [];
  const scheduled = [];
  const replies = [];
  const channel = {
    id: 'channel-1',
    type: 0,
    toString() { return '<#channel-1>'; },
    permissionOverwrites: {
      async edit(_target, permissions) { edits.push(permissions); }
    }
  };
  const interaction = {
    commandName: 'mutechat',
    user: { id: 'owner' },
    channel,
    guild: {
      id: 'guild',
      ownerId: 'owner',
      roles: { everyone: { id: 'guild' } },
      members: { async fetch() { return { id: 'owner', guild: { ownerId: 'owner' }, roles: { cache: new Map() } }; } }
    },
    options: {
      getChannel() { return channel; },
      getString(name) { return name === 'time' ? '10мин' : null; }
    },
    async deferReply() {},
    async editReply(value) { replies.push(value); }
  };
  const timerMap = new Map();

  await plugin.handleChannelMuteInteraction(interaction, {
    config: { ownerUserId: null, ownerRoleIds: new Set(), securityAdminRoleIds: new Set() },
    supportedChannelTypes: new Set([0]),
    timerMap,
    setTimer(callback, delay) { scheduled.push({ callback, delay }); return { id: 1 }; },
    clearTimer() {},
    async securityLog() {}
  });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 10 * 60 * 1000);
  assert.match(String(replies[0]), /10мин|10 мин/i);

  await scheduled[0].callback();
  assert.equal(edits.length, 2);
  assert.equal(edits[0].SendMessages, false);
  assert.equal(edits[1].SendMessages, null);
});

test('rejects durations above safe Node timer range', () => {
  assert.equal(plugin.parseMuteDuration('25д'), null);
  assert.equal(plugin.parseMuteDuration('24д'), 24 * 24 * 60 * 60 * 1000);
});
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  installChannelMutePlugin,
  handleChannelMuteInteraction
} = require('../src/channel-mute-plugin');

class FakeChannelOption {
  constructor() { this.data = {}; }
  setName(value) { this.data.name = value; return this; }
  setDescription(value) { this.data.description = value; return this; }
  setRequired(value) { this.data.required = value; return this; }
  addChannelTypes(...values) { this.data.channel_types = values; return this; }
}

class FakeSlashCommandBuilder {
  constructor() { this.data = { options: [] }; }
  setName(value) { this.data.name = value; return this; }
  setDescription(value) { this.data.description = value; return this; }
  addChannelOption(callback) {
    const option = callback(new FakeChannelOption());
    this.data.options.push(option.data);
    return this;
  }
  addStringOption(callback) {
    const option = callback(new FakeChannelOption());
    this.data.options.push(option.data);
    return this;
  }
  toJSON() { return structuredClone(this.data); }
}

class FakeREST {
  async put(_route, options) {
    return options.body;
  }
}

class FakeClient extends EventEmitter {}

test('install hook appends mute commands to AoS guild command registration', async () => {
  const discord = {
    REST: FakeREST,
    Client: FakeClient,
    SlashCommandBuilder: FakeSlashCommandBuilder,
    ChannelType: { GuildText: 0, GuildAnnouncement: 5, GuildForum: 15 }
  };

  installChannelMutePlugin(discord, {});

  const rest = new FakeREST();
  const body = await rest.put('/applications/app/guilds/guild/commands', {
    body: [
      { name: 'security-status' },
      { name: 'lockdown' },
      { name: 'panic' }
    ]
  });

  assert.deepEqual(body.map(command => command.name), [
    'security-status', 'lockdown', 'panic', 'mutechat', 'unmutechat'
  ]);
  assert.deepEqual(body[3].options[0].channel_types, [0, 5, 15]);
  assert.equal(body[3].options[0].required, false);
});

test('mute handler targets selected channel and reports success', async () => {
  const edits = [];
  const replies = [];
  const logs = [];
  const channel = {
    id: 'target-channel',
    type: 0,
    toString() { return '<#target-channel>'; },
    permissionOverwrites: {
      async edit(target, permissions, options) {
        edits.push({ target, permissions, options });
      }
    }
  };
  const everyone = { id: 'guild' };
  const member = {
    id: 'admin',
    guild: { ownerId: 'owner' },
    roles: { cache: new Map([['security-role', { id: 'security-role' }]]) }
  };
  const interaction = {
    commandName: 'mutechat',
    user: { id: 'admin' },
    channel,
    guild: {
      id: 'guild',
      ownerId: 'owner',
      roles: { everyone },
      members: { async fetch() { return member; } }
    },
    options: { getChannel() { return channel; } },
    async deferReply() {},
    async editReply(value) { replies.push(value); }
  };

  const handled = await handleChannelMuteInteraction(interaction, {
    config: {
      ownerUserId: null,
      ownerRoleIds: new Set(),
      securityAdminRoleIds: new Set(['security-role'])
    },
    supportedChannelTypes: new Set([0, 5, 15]),
    async securityLog(_guild, title, description) { logs.push({ title, description }); }
  });

  assert.equal(handled, true);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].permissions.SendMessages, false);
  assert.match(String(replies[0]), /замучен/i);
  assert.equal(logs[0].title, 'MUTECHAT');
});

test('permission failure is surfaced instead of reported as success', async () => {
  const replies = [];
  const channel = {
    id: 'target-channel',
    type: 0,
    toString() { return '<#target-channel>'; },
    permissionOverwrites: {
      async edit() {
        throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      }
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
      members: {
        async fetch() {
          return {
            id: 'owner',
            guild: { ownerId: 'owner' },
            roles: { cache: new Map() }
          };
        }
      }
    },
    options: { getChannel() { return channel; } },
    async deferReply() {},
    async editReply(value) { replies.push(value); }
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    const handled = await handleChannelMuteInteraction(interaction, {
      config: {
        ownerUserId: null,
        ownerRoleIds: new Set(),
        securityAdminRoleIds: new Set()
      },
      supportedChannelTypes: new Set([0]),
      async securityLog() {}
    });

    assert.equal(handled, true);
    assert.match(String(replies[0]), /нет прав|permissions/i);
    assert.doesNotMatch(String(replies[0]), /замучен\./i);
  } finally {
    console.error = originalError;
  }
});

test('client hook handles mutechat interactions emitted by discord client', async () => {
  const discord = {
    REST: class { async put(_route, options) { return options.body; } },
    Client: FakeClient,
    SlashCommandBuilder: FakeSlashCommandBuilder,
    ChannelType: { GuildText: 0, GuildAnnouncement: 5, GuildForum: 15 }
  };

  const originalLog = console.log;
  console.log = () => {};
  try {
    installChannelMutePlugin(discord, {});

    let edited = false;
    const channel = {
      id: 'channel',
      type: 0,
      toString() { return '<#channel>'; },
      permissionOverwrites: { async edit() { edited = true; } }
    };
    const interaction = {
      commandName: 'mutechat',
      isChatInputCommand() { return true; },
      user: { id: 'owner' },
      channel,
      guild: {
        id: 'guild',
        ownerId: 'owner',
        roles: { everyone: { id: 'guild' } },
        members: {
          async fetch() {
            return {
              id: 'owner',
              guild: { ownerId: 'owner' },
              roles: { cache: new Map() }
            };
          }
        },
        channels: { async fetch() { return null; } }
      },
      options: { getChannel() { return channel; } },
      async deferReply() {},
      async editReply() {}
    };

    const client = new FakeClient();
    client.emit('interactionCreate', interaction);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(edited, true);
  } finally {
    console.log = originalLog;
  }
});
const test = require('node:test');
const assert = require('node:assert/strict');

const { setChannelMute, hasSecurityAdminAccess } = require('../src/channel-mute');

test('mute denies messaging capabilities only on the selected channel', async () => {
  const calls = [];
  const everyone = { id: 'guild-id' };
  const channel = {
    permissionOverwrites: {
      async edit(target, permissions, options) {
        calls.push({ target, permissions, options });
      }
    }
  };

  await setChannelMute(channel, everyone, true, 'AoS test mute');

  assert.deepEqual(calls, [{
    target: everyone,
    permissions: {
      SendMessages: false,
      AddReactions: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false
    },
    options: { reason: 'AoS test mute' }
  }]);
});

test('unmute clears AoS channel overwrites instead of forcing allow', async () => {
  let permissions;
  const channel = {
    permissionOverwrites: {
      async edit(_target, nextPermissions) {
        permissions = nextPermissions;
      }
    }
  };

  await setChannelMute(channel, { id: 'guild-id' }, false, 'AoS test unmute');

  assert.deepEqual(permissions, {
    SendMessages: null,
    AddReactions: null,
    CreatePublicThreads: null,
    CreatePrivateThreads: null
  });
});

test('permission errors are propagated to the command handler', async () => {
  const expected = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  const channel = {
    permissionOverwrites: {
      async edit() {
        throw expected;
      }
    }
  };

  await assert.rejects(
    setChannelMute(channel, { id: 'guild-id' }, true, 'AoS test'),
    error => error === expected
  );
});

test('security admin access accepts server owner, explicit owner and configured security role', () => {
  const config = {
    ownerUserId: 'explicit-owner',
    ownerRoleIds: new Set(['owner-role']),
    securityAdminRoleIds: new Set(['security-role'])
  };

  const makeMember = (id, roleIds = []) => ({
    id,
    guild: { ownerId: 'server-owner' },
    roles: { cache: new Map(roleIds.map(roleId => [roleId, { id: roleId }])) }
  });

  assert.equal(hasSecurityAdminAccess(makeMember('server-owner'), config), true);
  assert.equal(hasSecurityAdminAccess(makeMember('explicit-owner'), config), true);
  assert.equal(hasSecurityAdminAccess(makeMember('user', ['owner-role']), config), true);
  assert.equal(hasSecurityAdminAccess(makeMember('user', ['security-role']), config), true);
  assert.equal(hasSecurityAdminAccess(makeMember('user', ['member-role']), config), false);
});
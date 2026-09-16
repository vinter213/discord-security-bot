async function setChannelMute(channel, everyoneRole, enabled, reason) {
  return channel.permissionOverwrites.edit(
    everyoneRole,
    {
      SendMessages: enabled ? false : null,
      AddReactions: enabled ? false : null,
      CreatePublicThreads: enabled ? false : null,
      CreatePrivateThreads: enabled ? false : null
    },
    { reason }
  );
}

function hasSecurityAdminAccess(member, config) {
  if (!member) return false;
  if (member.id === member.guild?.ownerId) return true;
  if (config.ownerUserId && member.id === config.ownerUserId) return true;

  const roles = member.roles?.cache;
  if (!roles) return false;

  for (const roleId of config.ownerRoleIds || []) {
    if (roles.has(roleId)) return true;
  }

  for (const roleId of config.securityAdminRoleIds || []) {
    if (roles.has(roleId)) return true;
  }

  return false;
}

module.exports = { setChannelMute, hasSecurityAdminAccess };
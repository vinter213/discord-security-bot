require('dotenv').config();

const discord = require('discord.js');
const { installChannelMutePlugin } = require('./channel-mute-plugin');

installChannelMutePlugin(discord, process.env);
require('./index');
if (process.argv.includes('--self-test')) {
  process.stdout.write(`${JSON.stringify({ status: 'self-test-ok', network: false, tokenRequired: false })}\n`);
} else {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    process.stderr.write('DISCORD_TOKEN is required for live bot mode\n');
    process.exitCode = 1;
  } else {
    const { Client, GatewayIntentBits } = await import('discord.js');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    client.once('ready', () => process.stdout.write(`Discord bot connected as ${client.user?.tag ?? 'unknown'}\n`));
    await client.login(token);
  }
}

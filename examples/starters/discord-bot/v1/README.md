# Discord bot starter v1

This private worker uses discord.js 14.27.0 and has no public ingress. Live mode requires `DISCORD_TOKEN` from a secret binding and only connects a client; it never sends a test message.

`pnpm self-test` is a separate tokenless, offline process check. Its `network: false` result must not be interpreted as a live Discord connection.

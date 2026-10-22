# Discord message cleaner

Requires Node.js 22+ and a Discord application/bot with **Manage Messages** and **Read Message History** permissions. Enable the **Message Content** privileged intent for the guild message-search endpoint.

```sh
npm install
DISCORD_TOKEN=... DISCORD_CLIENT_ID=... npm start
```

Invite the bot with `bot` and `applications.commands` scopes. The bot registers global slash commands on startup. It runs a search sweep at startup and every 12 hours, deleting registered users' messages between 11 and 14 days old. Search results are subject to Discord indexing and pagination limits.

Commands: `/cleanup register`, `/cleanup unregister`, `/cleanup status`, `/cleanup metrics`, and `/cleanup server status`. Metrics show the invoking user's deleted-message totals for this server and across all servers. Responses are ephemeral. Registrations and metrics persist in `registrations.json`.

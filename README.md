# Discord message cleaner

A discord bot to remove user messages from servers. Features:
- Player have to explicitely register themselves to be cleaned up
- Ability to exclude channels from cleanup
- Some metrics
- Prefers deleting messages less than 14 days old using the bulk deletion API, but can fall back to manually deleting every message

Commands: `/cleanup register`, `/cleanup unregister`, `/cleanup status`, `/cleanup server status`, `/cleanup server include`, `/cleanup server exclude`.

# Usage
- Copy config.example.json to config.json and edit
- `docker compose up -d`
- That' it !

# Licence

[GPL-2.0-only OR GPL-3.0-or-later with proxy being me (iTrooz)](https://itrooz.fr/posts/gpl_licence/)

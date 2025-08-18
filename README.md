# minecraft-mcp-mineflayer
An MCP server that lets AI agents control Mineflayer bots to join, play, and interact with Minecraft servers.

Links for reference:
- Mineflayer: `https://github.com/PrismarineJS/mineflayer`
- Pathfinder: `https://github.com/Karang/mineflayer-pathfinder`
- PvP plugin: `https://github.com/PrismarineJS/mineflayer-pvp`
- Auto Eat: `https://github.com/link-discord/mineflayer-auto-eat`

## Quick start

1. Install dependencies
```bash
npm install
```

2. Build
```bash
npm run build
```

3. Run (as an MCP server over stdio)
```bash
npm start
```

This exposes MCP tools such as `joinGame`, `leaveGame`, `goToKnownLocation`, `goToSomeone`, `sendChat`, `readChat`, `attackSomeone`, `openInventory`, `equipItem`, `dropItem`, `giveItemToSomeone`, `lookAround`, and `eatFood`.

### Example tool call (JSON-RPC over stdio)
Call `joinGame`:
```json
{
  "method": "tools/call",
  "params": {
    "name": "joinGame",
    "arguments": { "username": "Agent", "host": "localhost", "port": 25565 }
  },
  "id": 1
}
```

### Notes
- Requires a running Minecraft server.
- If using online servers, ensure authentication and version compatibility.

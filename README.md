## minecraft-mcp-mineflayer
An MCP server that lets AI agents spawn and control Mineflayer bots to join, play, and interact with Minecraft servers. It is toolset over MCP stdio including movement, combat (ranged/melee), resource gathering, crafting/smelting across device types, inventory and equipment management, farming, storage, building, vision, and communication.

### What it does
- Runs an MCP stdio server backed by Mineflayer
- Spawns bots, loads plugins, and executes high‑level actions with auto‑navigation
- Each tool response includes live status: health, food, oxygen/drowning, effects, last damage, last broken equipment, and equipped summary (main/off hand + armor with durability info when available)

### Plugins used
- mineflayer-pathfinder
- mineflayer-armor-manager
- mineflayer-pvp
- mineflayer-auto-eat
- mineflayer-tool
- mineflayer-collectblock
- mineflayer-statemachine

### Install
```bash
git clone https://github.com/XanderXML-Bit/minecraft-mcp-mineflayer.git
cd minecraft-mcp-mineflayer/minecraft-mcp-mineflayer
npm install
npx -y tsc -p tsconfig.json
```

### Configure MCP client (works with any MCP-capable client)
This server communicates over MCP stdio and can be used by any MCP client (e.g., Cursor). Below shows Cursor configuration:
Create or edit `~/.cursor/mcp.json` (Windows: `C:\Users\<you>\.cursor\mcp.json`) and point at the built server:
```json
{
  "mcpServers": {
    "minecraft": {
      "command": "node",
      "args": [
        "C:/Users/<you>/path/to/minecraft-mcp-mineflayer/dist/index.js"
      ]
    }
  }
}
```
Toggle the MCP in Cursor’s settings.

### Key tools (selection)
- joinGame, leaveGame
- goToKnownLocation, goToSomeone, moveInDirection, jump, followPlayer, stopFollow, runAway, swimToLand
- attackSomeone (uses bow at range when bow+arrows available, melee otherwise), hunt, stopAttack, selfDefense
  - Bow is used automatically when the target is > 8 blocks and bow+arrows are present; otherwise melee.
- mineResource, harvestMatureCrops, pickupItem
- craftItems, listRecipes
- smeltItem/cookItem (auto device selection: smoker/blast furnace/furnace; prefers smoker for food, blast furnace for ores)
- cookWithSmoker, smeltWithBlastFurnace, cookWithCampfire, retrieveItemsFromNearbyFurnace
- openInventory, listInventory, equipItem (destination: hand/off-hand/head/torso/legs/feet), dropItem, giveItemToSomeone
- placeItemNearYou, prepareLandForFarming, plantSeedsWithinRadius, useItemOnBlockOrEntity, buildSomething
- openNearbyChest, depositItemsToNearbyChest, withdrawItemsFromNearbyChest
- lookAround, scanArea, findBlock, findEntity, sendChat, readChat, detectGamemode, getPosition, lookAt
- dance, rest, sleepInNearbyBed

### Examples
```json
{"name":"joinGame","arguments":{"username":"Zen","host":"localhost","port":25565}}
{"name":"attackSomeone","arguments":{"username":"Zen","targetType":"player"}}
{"name":"smeltItem","arguments":{"username":"Zen","itemName":"iron_ore"}}
{"name":"cookWithSmoker","arguments":{"username":"Zen","itemName":"beef"}}
{"name":"equipItem","arguments":{"username":"Zen","name":"iron_helmet","destination":"head"}}
{"name":"listRecipes","arguments":{"username":"Zen","itemName":"stone_pickaxe"}}
{"name":"craftItems","arguments":{"username":"Zen","itemName":"stone_pickaxe","count":1,"maxMs":60000}}
```

### Crafting details
- listRecipes: returns per-recipe ingredients, whether a crafting table is required, and how many units are currently craftable with the bot’s inventory.
- craftItems: auto-finds/places a crafting table if needed, moves into range, crafts up to `count`, and returns partial-progress and diagnostics:
  - Fields include: `requested`, `crafted`, `remaining`, `usedTable`, `timedOut`, `reason` (`missing_resources` | `missing_table` | undefined), `missingItems` (when resources are missing), and `errors`.
  - You may set `maxMs` to bound total crafting time; the tool also uses small per-batch timeouts to avoid stalling.


### References
- Mineflayer: `https://github.com/PrismarineJS/mineflayer`
- mineflayer-pathfinder: `https://github.com/Karang/mineflayer-pathfinder`
- mineflayer-pvp: `https://github.com/PrismarineJS/mineflayer-pvp`
- mineflayer-auto-eat: `https://github.com/link-discord/mineflayer-auto-eat`
- mineflayer-armor-manager: `https://github.com/G07cha/MineflayerArmorManager`
- mineflayer-tool: `https://github.com/TheDudeFromCI/mineflayer-tool`
- mineflayer-collectblock: `https://github.com/PrismarineJS/mineflayer-collectblock`
- mineflayer-statemachine: `https://github.com/PrismarineJS/mineflayer-statemachine`
- MCP SDK: `https://github.com/modelcontextprotocol/sdk`

import { Server } from "@modelcontextprotocol/sdk/server";
import mineflayer, { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import armorManager from "mineflayer-armor-manager";
import pvpPkg from "mineflayer-pvp";
import { loader as autoEatPlugin } from "mineflayer-auto-eat";
import toolPkg from "mineflayer-tool";
import collectBlockPkg from "mineflayer-collectblock";
import { Vec3 } from "vec3";
import {
  StateTransition,
  BotStateMachine,
  EntityFilters,
  BehaviorFollowEntity,
  BehaviorLookAtEntity,
  BehaviorGetClosestEntity,
  NestedStateMachine
} from "mineflayer-statemachine";

// Handle CJS interop for mineflayer-pathfinder and plugins
const { pathfinder, Movements, goals } = (pathfinderPkg as any);
const { plugin: pvp } = (pvpPkg as any);
const { plugin: toolPlugin } = (toolPkg as any);
const { plugin: collectBlockPlugin } = (collectBlockPkg as any);

const log = (...args: unknown[]) => {
  try {
    // Log to stderr so we don't interfere with MCP stdio protocol on stdout
    // eslint-disable-next-line no-console
    console.error("[minecraft-mcp]", ...args);
  } catch {}
};
type BotRegistry = Map<string, Bot>;
const bots: BotRegistry = new Map();

function getBotOrThrow(username?: string): Bot {
  if (username && bots.has(username)) return bots.get(username)!;
  if (username && !bots.has(username)) throw new Error(`Bot '${username}' not found`);
  const [first] = bots.values();
  if (!first) throw new Error("No active bots. Use joinGame first.");
  return first;
}

async function joinGame(params: Record<string, unknown>) {
  const username = String(params.username || "Agent");
  const host = params.host ? String(params.host) : "localhost";
  const port = params.port ? Number(params.port) : 25565;
  if (bots.has(username)) throw new Error(`Bot '${username}' already exists`);

  const bot = mineflayer.createBot({ host, port, username });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(armorManager as any);
  bot.loadPlugin(pvp as any);
  bot.loadPlugin(autoEatPlugin as any);
  bot.loadPlugin(toolPlugin as any);
  bot.loadPlugin(collectBlockPlugin as any);

  bot.once("login", () => {
    // Configure auto eat
    try {
      // @ts-ignore
      bot.autoEat.options = { priority: "foodPoints", minHunger: 15 };
    } catch {}
  });

  bot.on("end", () => {
    if (bots.get(username) === bot) bots.delete(username);
  });

  bots.set(username, bot);
  await new Promise<void>((resolve, reject) => {
    const onLogin = () => { cleanup(); resolve(); };
    const onError = (e: Error) => { cleanup(); reject(e); };
    const onKicked = (reason: any) => { cleanup(); reject(new Error(String(reason))); };
    const cleanup = () => {
      bot.removeListener("login", onLogin);
      bot.removeListener("error", onError);
      // @ts-ignore
      bot.removeListener("kicked", onKicked);
    };
    bot.once("login", onLogin);
    bot.once("error", onError);
    // @ts-ignore
    bot.once("kicked", onKicked);
  });

  return { ok: true, username };
}

async function leaveGame(params: Record<string, unknown>) {
  const username = params.username ? String(params.username) : undefined;
  const disconnectAll = Boolean(params.disconnectAll);
  if (disconnectAll) {
    for (const [name, bot] of bots) {
      bot.end();
      bots.delete(name);
    }
    return { ok: true, disconnected: "all" };
  }
  const bot = getBotOrThrow(username);
  bot.end();
  bots.delete(bot.username);
  return { ok: true, username: bot.username };
}

async function goToKnownLocation(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  const range = params.range ? Number(params.range) : 1;
  const mcDataMod = await import("minecraft-data");
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  return { ok: true };
}

async function goToSomeone(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const targetName = String(params.userName || params.username || "");
  const player = bot.players[targetName]?.entity;
  if (!player) throw new Error(`Player '${targetName}' not found`);
  const mcDataMod = await import("minecraft-data");
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalFollow(player, Number(params.distance ?? 3)));
  return { ok: true };
}

async function sendChat(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const message = String(params.message || "");
  bot.chat(message);
  return { ok: true };
}

async function getPosition(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const p = bot.entity.position;
  return { ok: true, position: { x: p.x, y: p.y, z: p.z } };
}

async function lookAt(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  await bot.lookAt(new Vec3(x, y, z), true);
  return { ok: true };
}

async function jump(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  bot.setControlState("jump", true);
  await new Promise(r => setTimeout(r, Number(params.duration ?? 500)));
  bot.setControlState("jump", false);
  return { ok: true };
}

async function moveInDirection(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const direction = String(params.direction || "forward");
  const ms = Number(params.durationMs ?? 1000);
  const map: Record<string, keyof typeof bot.controlState> = {
    forward: "forward",
    back: "back",
    left: "left",
    right: "right",
    sprint: "sprint",
    sneak: "sneak"
  } as any;
  const key = map[direction];
  if (!key) throw new Error("Invalid direction");
  // @ts-ignore
  bot.setControlState(key, true);
  await new Promise(r => setTimeout(r, ms));
  // @ts-ignore
  bot.setControlState(key, false);
  return { ok: true };
}

async function startSimpleStateMachine(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  // Ensure pathfinder is loaded already
  const targets: any = {};
  const getClosestPlayer = new BehaviorGetClosestEntity(bot as any, targets, EntityFilters().PlayersOnly);
  const follow = new BehaviorFollowEntity(bot as any, targets);
  const look = new BehaviorLookAtEntity(bot as any, targets);
  const transitions = [
    new StateTransition({ parent: getClosestPlayer, child: follow, shouldTransition: () => true }),
    new StateTransition({ parent: follow, child: look, shouldTransition: () => follow.distanceToTarget() < 2 }),
    new StateTransition({ parent: look, child: follow, shouldTransition: () => look.distanceToTarget() >= 2 })
  ];
  const root = new NestedStateMachine(transitions, getClosestPlayer);
  new BotStateMachine(bot as any, root);
  return { ok: true };
}

async function runAway(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const threat = bot.nearestEntity((e: any) => e.type === 'mob') || bot.nearestEntity();
  const distance = Number(params.distance ?? 16);
  const p = bot.entity.position.clone();
  const t = threat?.position || p.offset(1, 0, 0);
  const dir = p.minus(t).scaled(1);
  const target = p.plus(dir.scaled(distance));
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), 2));
  return { ok: true };
}

async function swimToLand(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const origin = bot.entity.position.floored();
  let found: any = null;
  for (let r = 1; r <= 16 && !found; r++) {
    for (let dx = -r; dx <= r && !found; dx++) {
      for (let dz = -r; dz <= r && !found; dz++) {
        const x = origin.x + dx, z = origin.z + dz;
        for (let dy = -1; dy <= 2 && !found; dy++) {
          const y = origin.y + dy;
          const blockBelow = bot.blockAt(new Vec3(x, y - 1, z));
          const here = bot.blockAt(new Vec3(x, y, z));
          const above = bot.blockAt(new Vec3(x, y + 1, z));
          const liquidBelow = blockBelow && (blockBelow as any).liquid;
          const solidBelow = blockBelow && blockBelow.boundingBox === 'block' && !(blockBelow as any).liquid;
          const space = here && here.boundingBox === 'empty' && above && above.boundingBox === 'empty';
          if (solidBelow && space && !liquidBelow) { found = new Vec3(x, y, z); }
        }
      }
    }
  }
  if (!found) throw new Error('No nearby land found');
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(found.x, found.y, found.z, 1));
  return { ok: true };
}

async function hunt(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const name = String(params.targetName || params.targetType || 'cow');
  const ent = bot.nearestEntity((e: any) => (e.name === name || e.displayName === name || e.kind === name));
  if (!ent) throw new Error('No target found');
  // @ts-ignore
  bot.pvp.attack(ent);
  const seconds = Number(params.duration ?? 20);
  await new Promise(r => setTimeout(r, seconds * 1000));
  // @ts-ignore
  bot.pvp.stop();
  return { ok: true };
}

async function mineResource(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const blockName = String(params.blockName || params.resource || 'stone');
  const count = Number(params.count ?? 1);
  const positions = bot.findBlocks({ matching: (b: any) => b?.name === blockName, maxDistance: 64, count });
  if (!positions.length) throw new Error(`No ${blockName} nearby`);
  const blocks = positions.map((v: any) => bot.blockAt(v)).filter(Boolean) as any[];
  for (const b of blocks) {
    // @ts-ignore
    await bot.collectBlock.collect(b);
  }
  return { ok: true };
}

async function harvestMatureCrops(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const crops = ['wheat', 'carrots', 'potatoes', 'beetroots'];
  const positions = bot.findBlocks({
    matching: (b: any) => {
      if (!b) return false;
      if (!crops.includes(b.name)) return false;
      const age = (b as any).getProperties?.().age ?? (b as any).metadata ?? 0;
      return age >= 7;
    },
    maxDistance: 64,
    count: Number(params.count ?? 8)
  });
  if (!positions.length) throw new Error('No mature crops found');
  const blocks = positions.map((v: any) => bot.blockAt(v)).filter(Boolean) as any[];
  for (const b of blocks) {
    // @ts-ignore
    await bot.collectBlock.collect(b);
  }
  return { ok: true, harvested: blocks.length };
}

async function pickupItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = params.itemName ? String(params.itemName) : undefined;
  const ent = bot.nearestEntity((e: any) => e.type === 'object' && (!itemName || e.displayName === itemName));
  if (!ent) throw new Error('No dropped item found');
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalFollow(ent, 1));
  await bot.waitForTicks(20);
  return { ok: true };
}

async function openNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const pos = bot.findBlock({ matching: (b: any) => b?.name === 'chest' || b?.name?.includes('chest'), maxDistance: 16 });
  if (!pos) throw new Error('No chest nearby');
  const chest = await bot.openChest(pos as any);
  await bot.waitForTicks(10);
  chest.close();
  return { ok: true };
}

async function craftItems(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || 'stick');
  const count = Number(params.count ?? 1);
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) throw new Error(`Unknown item ${itemName}`);
  const recipes = bot.recipesFor(item.id, null, 1, null);
  if (!recipes || recipes.length === 0) throw new Error('No recipe');
  const tablePos = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 });
  await bot.craft(recipes[0], count, (tablePos as any) || null);
  return { ok: true };
}

async function smeltItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || 'iron_ore');
  const fuelName = String(params.fuelName || 'coal');
  const furnacePos = bot.findBlock({ matching: (b: any) => b?.name === 'furnace', maxDistance: 16 });
  if (!furnacePos) throw new Error('No furnace nearby');
  const furnace = await bot.openFurnace(furnacePos as any);
  const item = bot.inventory.items().find(i => i.name === itemName);
  const fuel = bot.inventory.items().find(i => i.name === fuelName);
  if (!item || !fuel) { furnace.close(); throw new Error('Missing input or fuel'); }
  await furnace.putInput(item.type, null, 1);
  await furnace.putFuel(fuel.type, null, 1);
  await bot.waitForTicks(40);
  const out = await furnace.takeOutput();
  furnace.close();
  return { ok: true, output: out?.name };
}

async function cookItem(params: Record<string, unknown>) {
  return smeltItem(params);
}

async function retrieveItemsFromNearbyFurnace(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const furnacePos = bot.findBlock({ matching: (b: any) => b?.name === 'furnace', maxDistance: 16 });
  if (!furnacePos) throw new Error('No furnace nearby');
  const furnace = await bot.openFurnace(furnacePos as any);
  const out = await furnace.takeOutput();
  furnace.close();
  return { ok: true, output: out?.name };
}

async function placeItemNearYou(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || 'cobblestone');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error('Item not in inventory');
  const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
  const face = new Vec3(0, 1, 0);
  await bot.equip(item, 'hand');
  await bot.placeBlock(ref as any, face);
  return { ok: true };
}

async function prepareLandForFarming(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const hoe = bot.inventory.items().find(i => i.name?.includes('hoe'));
  if (!hoe) throw new Error('No hoe in inventory');
  const dirtPos = bot.findBlock({ matching: (b: any) => b?.name === 'dirt' || b?.name === 'grass_block', maxDistance: 16 });
  if (!dirtPos) throw new Error('No dirt/grass nearby');
  await bot.equip(hoe, 'hand');
  await bot.activateBlock(dirtPos as any);
  return { ok: true };
}

async function useItemOnBlockOrEntity(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  if (params.x != null && params.y != null && params.z != null) {
    const b = bot.blockAt(new Vec3(Number(params.x), Number(params.y), Number(params.z)));
    if (!b) throw new Error('Block not found');
    await bot.activateBlock(b as any);
    return { ok: true };
  }
  if (params.userName) {
    const ent = bot.players[String(params.userName)]?.entity;
    if (!ent) throw new Error('Player not found');
    await bot.activateEntity(ent as any);
    return { ok: true };
  }
  throw new Error('Specify block coords or userName');
}

async function rest(params: Record<string, unknown>) {
  const ms = Number(params.ms ?? 2000);
  await new Promise(r => setTimeout(r, ms));
  return { ok: true };
}

async function sleepInNearbyBed(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const bedPos = bot.findBlock({ matching: (b: any) => b?.name?.includes('bed'), maxDistance: 16 });
  if (!bedPos) throw new Error('No bed nearby');
  await bot.sleep(bedPos as any);
  return { ok: true };
}

async function dance(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const duration = Number(params.durationMs ?? 3000);
  const start = Date.now();
  while (Date.now() - start < duration) {
    bot.setControlState('left', true); await bot.waitForTicks(5); bot.setControlState('left', false);
    bot.setControlState('right', true); await bot.waitForTicks(5); bot.setControlState('right', false);
    bot.setControlState('sneak', true); await bot.waitForTicks(5); bot.setControlState('sneak', false);
  }
  return { ok: true };
}

async function buildSomething(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const cmds = params.commands as string[] | undefined;
  if (!Array.isArray(cmds) || cmds.length === 0) throw new Error('Provide commands array');
  for (const c of cmds) bot.chat(c);
  return { ok: true };
}

async function depositItemsToNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || '');
  const count = params.count != null ? Number(params.count) : null;
  if (!itemName) throw new Error('itemName required');
  const chestPos = bot.findBlock({ matching: (b: any) => b?.name?.includes('chest'), maxDistance: 16 });
  if (!chestPos) throw new Error('No chest nearby');
  const chest = await bot.openChest(chestPos as any);
  try {
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) throw new Error('Item not in inventory');
    await chest.deposit(item.type, null, count ?? item.count);
    return { ok: true };
  } finally {
    chest.close();
  }
}

async function withdrawItemsFromNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || '');
  const count = params.count != null ? Number(params.count) : null;
  if (!itemName) throw new Error('itemName required');
  const chestPos = bot.findBlock({ matching: (b: any) => b?.name?.includes('chest'), maxDistance: 16 });
  if (!chestPos) throw new Error('No chest nearby');
  const chest = await bot.openChest(chestPos as any);
  try {
    const mcDataMod = await import('minecraft-data');
    const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
    const item = mcData.itemsByName[itemName];
    if (!item) throw new Error(`Unknown item ${itemName}`);
    await chest.withdraw(item.id, null, count ?? 1);
    return { ok: true };
  } finally {
    chest.close();
  }
}

async function digBlock(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) throw new Error('Block not found');
  await bot.dig(block as any);
  return { ok: true };
}

async function placeBlockAt(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  const itemName = String(params.itemName || params.name || '');
  if (!itemName) throw new Error('itemName required');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error('Item not in inventory');
  const below = bot.blockAt(new Vec3(x, y - 1, z));
  if (!below) throw new Error('No support block below target');
  await bot.equip(item, 'hand');
  await bot.placeBlock(below as any, new Vec3(0, 1, 0));
  return { ok: true };
}

async function listInventory(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
  return { ok: true, items };
}

async function detectGamemode(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const gmNum = Number(bot.game?.gameMode);
  const map: Record<number, string> = { 0: 'survival', 1: 'creative', 2: 'adventure', 3: 'spectator' };
  return { ok: true, gameMode: map[gmNum] ?? String(gmNum) };
}

async function findBlock(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const name = String(params.blockName || params.name || '');
  if (!name) throw new Error('blockName required');
  const pos = bot.findBlock({ matching: (b: any) => b?.name === name, maxDistance: 64 });
  if (!pos) throw new Error('Not found');
  const p = (pos as any).position || pos;
  return { ok: true, position: { x: p.x, y: p.y, z: p.z } };
}

async function findEntity(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const name = String(params.targetName || params.type || '');
  const ent = name ? bot.nearestEntity((e: any) => e.name === name || e.displayName === name || e.kind === name)
                   : bot.nearestEntity();
  if (!ent) throw new Error('Not found');
  const p = ent.position || bot.entity.position;
  return { ok: true, entity: { name: ent.name || ent.username, position: { x: p.x, y: p.y, z: p.z } } };
}

async function readChat(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  // Mineflayer doesn't buffer chat history; we expose last N captured messages
  // Simple in-memory buffer per bot
  // @ts-ignore
  if (!bot.__chatLog) {
    // @ts-ignore
    bot.__chatLog = [] as Array<{ type: string; text: string; from?: string; time: number }>;
    bot.on("chat", (username: string, message: string) => {
      // @ts-ignore
      bot.__chatLog.push({ type: "chat", text: message, from: username, time: Date.now() });
      // @ts-ignore
      if (bot.__chatLog.length > 100) bot.__chatLog.shift();
    });
    bot.on("message", (jsonMsg: any) => {
      const text = jsonMsg?.toString?.() ?? String(jsonMsg?.text ?? "");
      // @ts-ignore
      bot.__chatLog.push({ type: "system", text, time: Date.now() });
      // @ts-ignore
      if (bot.__chatLog.length > 100) bot.__chatLog.shift();
    });
  }
  const count = Number(params.count ?? 20);
  // @ts-ignore
  const slice = bot.__chatLog.slice(-count);
  return { ok: true, messages: slice };
}

async function attackSomeone(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const type = String(params.targetType || "player");
  const name = params.targetName ? String(params.targetName) : undefined;
  let entity: any;
  if (name) {
    entity = Object.values(bot.entities).find((e: any) => e.name === name || e.username === name);
  } else {
    entity = Object.values(bot.entities).find((e: any) => type === "player" ? e.type === "player" : e.kind === type);
  }
  if (!entity) throw new Error("Target not found");
  // @ts-ignore
  bot.pvp.attack(entity);
  const duration = Number(params.duration ?? 20);
  await new Promise((r) => setTimeout(r, duration * 1000));
  // @ts-ignore
  bot.pvp.stop();
  return { ok: true };
}

async function openInventory(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
  return { ok: true, items };
}

async function equipItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.name || params.itemName || "");
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error(`Item '${itemName}' not found in inventory`);
  await bot.equip(item, "hand");
  return { ok: true };
}

async function dropItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.name || "");
  const count = params.count ? Number(params.count) : undefined;
  const items = bot.inventory.items().filter(i => i.name === itemName);
  if (items.length === 0) throw new Error(`Item '${itemName}' not found`);
  for (const i of items) {
    if (count && i.count > count) { await bot.toss(i.type, null, count); break; }
    await bot.toss(i.type, null, i.count);
  }
  return { ok: true };
}

async function giveItemToSomeone(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const targetName = String(params.userName || "");
  const itemName = String(params.itemName || "");
  const itemCount = Number(params.itemCount ?? 1);
  const player = bot.players[targetName]?.entity;
  if (!player) throw new Error(`Player '${targetName}' not found`);
  const item = bot.inventory.items().find(i => i.name === itemName && i.count >= itemCount);
  if (!item) throw new Error(`Not enough '${itemName}'`);
  await bot.toss(item.type, null, itemCount);
  return { ok: true };
}

async function lookAround(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const yaw = Number(params.yaw ?? Math.random() * Math.PI * 2);
  const pitch = Number(params.pitch ?? (Math.random() - 0.5));
  await bot.look(yaw, pitch, true);
  return { ok: true };
}

async function eatFood(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  // @ts-ignore
  if (!bot.autoEat) throw new Error("auto-eat not available");
  // @ts-ignore
  await bot.autoEat.eat();
  return { ok: true };
}

async function sendToolCall(req: any): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const name = (req as any).params.name as string;
  const args = ((req as any).params.arguments as any) ?? {};
  switch (name) {
    case "joinGame": return { content: [{ type: "text", text: JSON.stringify(await joinGame(args)) }] };
    case "leaveGame": return { content: [{ type: "text", text: JSON.stringify(await leaveGame(args)) }] };
    case "goToSomeone": return { content: [{ type: "text", text: JSON.stringify(await goToSomeone(args)) }] };
    case "goToKnownLocation": return { content: [{ type: "text", text: JSON.stringify(await goToKnownLocation(args)) }] };
    case "sendChat": return { content: [{ type: "text", text: JSON.stringify(await sendChat(args)) }] };
    case "readChat": return { content: [{ type: "text", text: JSON.stringify(await readChat(args)) }] };
    case "attackSomeone": return { content: [{ type: "text", text: JSON.stringify(await attackSomeone(args)) }] };
    case "openInventory": return { content: [{ type: "text", text: JSON.stringify(await openInventory(args)) }] };
    case "equipItem": return { content: [{ type: "text", text: JSON.stringify(await equipItem(args)) }] };
    case "dropItem": return { content: [{ type: "text", text: JSON.stringify(await dropItem(args)) }] };
    case "giveItemToSomeone": return { content: [{ type: "text", text: JSON.stringify(await giveItemToSomeone(args)) }] };
    case "lookAround": return { content: [{ type: "text", text: JSON.stringify(await lookAround(args)) }] };
    case "eatFood": return { content: [{ type: "text", text: JSON.stringify(await eatFood(args)) }] };
    case "getPosition": return { content: [{ type: "text", text: JSON.stringify(await getPosition(args)) }] };
    case "lookAt": return { content: [{ type: "text", text: JSON.stringify(await lookAt(args)) }] };
    case "jump": return { content: [{ type: "text", text: JSON.stringify(await jump(args)) }] };
    case "moveInDirection": return { content: [{ type: "text", text: JSON.stringify(await moveInDirection(args)) }] };
    case "startSimpleStateMachine": return { content: [{ type: "text", text: JSON.stringify(await startSimpleStateMachine(args)) }] };
    case "runAway": return { content: [{ type: "text", text: JSON.stringify(await runAway(args)) }] };
    case "swimToLand": return { content: [{ type: "text", text: JSON.stringify(await swimToLand(args)) }] };
    case "hunt": return { content: [{ type: "text", text: JSON.stringify(await hunt(args)) }] };
    case "mineResource": return { content: [{ type: "text", text: JSON.stringify(await mineResource(args)) }] };
    case "harvestMatureCrops": return { content: [{ type: "text", text: JSON.stringify(await harvestMatureCrops(args)) }] };
    case "pickupItem": return { content: [{ type: "text", text: JSON.stringify(await pickupItem(args)) }] };
    case "craftItems": return { content: [{ type: "text", text: JSON.stringify(await craftItems(args)) }] };
    case "cookItem": return { content: [{ type: "text", text: JSON.stringify(await cookItem(args)) }] };
    case "smeltItem": return { content: [{ type: "text", text: JSON.stringify(await smeltItem(args)) }] };
    case "retrieveItemsFromNearbyFurnace": return { content: [{ type: "text", text: JSON.stringify(await retrieveItemsFromNearbyFurnace(args)) }] };
    case "placeItemNearYou": return { content: [{ type: "text", text: JSON.stringify(await placeItemNearYou(args)) }] };
    case "prepareLandForFarming": return { content: [{ type: "text", text: JSON.stringify(await prepareLandForFarming(args)) }] };
    case "useItemOnBlockOrEntity": return { content: [{ type: "text", text: JSON.stringify(await useItemOnBlockOrEntity(args)) }] };
    case "rest": return { content: [{ type: "text", text: JSON.stringify(await rest(args)) }] };
    case "sleepInNearbyBed": return { content: [{ type: "text", text: JSON.stringify(await sleepInNearbyBed(args)) }] };
    case "openNearbyChest": return { content: [{ type: "text", text: JSON.stringify(await openNearbyChest(args)) }] };
    case "dance": return { content: [{ type: "text", text: JSON.stringify(await dance(args)) }] };
    case "buildSomething": return { content: [{ type: "text", text: JSON.stringify(await buildSomething(args)) }] };
    case "depositItemsToNearbyChest": return { content: [{ type: "text", text: JSON.stringify(await depositItemsToNearbyChest(args)) }] };
    case "withdrawItemsFromNearbyChest": return { content: [{ type: "text", text: JSON.stringify(await withdrawItemsFromNearbyChest(args)) }] };
    case "digBlock": return { content: [{ type: "text", text: JSON.stringify(await digBlock(args)) }] };
    case "placeBlockAt": return { content: [{ type: "text", text: JSON.stringify(await placeBlockAt(args)) }] };
    case "listInventory": return { content: [{ type: "text", text: JSON.stringify(await listInventory(args)) }] };
    case "detectGamemode": return { content: [{ type: "text", text: JSON.stringify(await detectGamemode(args)) }] };
    case "findBlock": return { content: [{ type: "text", text: JSON.stringify(await findBlock(args)) }] };
    case "findEntity": return { content: [{ type: "text", text: JSON.stringify(await findEntity(args)) }] };
    default:
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown tool" }) }] };
  }
}

function listTools() {
  const tools = [
    { name: "joinGame", description: "Spawn a new bot into the Minecraft game", inputSchema: { type: "object", properties: { username: { type: "string" }, host: { type: "string" }, port: { type: "number" } }, required: ["username"] } },
    { name: "leaveGame", description: "Disconnect bot(s) from the game", inputSchema: { type: "object", properties: { username: { type: "string" }, disconnectAll: { type: "boolean" } } } },
    { name: "goToSomeone", description: "Navigate to another player", inputSchema: { type: "object", properties: { username: { type: "string" }, userName: { type: "string" }, distance: { type: "number" } }, required: ["userName"] } },
    { name: "goToKnownLocation", description: "Navigate to specific coordinates", inputSchema: { type: "object", properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, range: { type: "number" } }, required: ["x", "y", "z"] } },
    { name: "attackSomeone", description: "Attack players, mobs, or animals", inputSchema: { type: "object", properties: { username: { type: "string" }, targetType: { type: "string" }, targetName: { type: "string" }, duration: { type: "number" } } } },
    { name: "openInventory", description: "Open the bot's inventory", inputSchema: { type: "object", properties: { username: { type: "string" } } } },
    { name: "equipItem", description: "Equip armor, tools, or weapons", inputSchema: { type: "object", properties: { username: { type: "string" }, name: { type: "string" } }, required: ["name"] } },
    { name: "dropItem", description: "Drop items from inventory", inputSchema: { type: "object", properties: { username: { type: "string" }, name: { type: "string" }, count: { type: "number" } }, required: ["name"] } },
    { name: "giveItemToSomeone", description: "Give items to another player", inputSchema: { type: "object", properties: { username: { type: "string" }, userName: { type: "string" }, itemName: { type: "string" }, itemCount: { type: "number" } }, required: ["userName", "itemName"] } },
    { name: "lookAround", description: "Look around and observe the environment", inputSchema: { type: "object", properties: { username: { type: "string" }, yaw: { type: "number" }, pitch: { type: "number" } } } },
    { name: "sendChat", description: "Send chat messages or commands to the server", inputSchema: { type: "object", properties: { username: { type: "string" }, message: { type: "string" } }, required: ["message"] } },
    { name: "readChat", description: "Read recent chat messages from the server", inputSchema: { type: "object", properties: { username: { type: "string" }, count: { type: "number" } } } },
    { name: "eatFood", description: "Eat food to restore hunger", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "getPosition", description: "Get the current position of the bot", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "lookAt", description: "Make the bot look at specific coordinates", inputSchema: { type: "object", properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } }
    ,{ name: "jump", description: "Make the bot jump for a duration (ms)", inputSchema: { type: "object", properties: { username: { type: "string" }, duration: { type: "number" } } } }
    ,{ name: "moveInDirection", description: "Move in a direction for duration (ms)", inputSchema: { type: "object", properties: { username: { type: "string" }, direction: { type: "string", enum: ["forward","back","left","right","sprint","sneak"] }, durationMs: { type: "number" } }, required: ["direction"] } }
    ,{ name: "startSimpleStateMachine", description: "Start a simple state machine to follow and look at the nearest player", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "runAway", description: "Run away from threats", inputSchema: { type: "object", properties: { username: { type: "string" }, distance: { type: "number" } } } }
    ,{ name: "swimToLand", description: "Swim to nearest land when in water", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "hunt", description: "Hunt animals or mobs", inputSchema: { type: "object", properties: { username: { type: "string" }, targetName: { type: "string" }, duration: { type: "number" } } } }
    ,{ name: "mineResource", description: "Mine specific blocks or resources", inputSchema: { type: "object", properties: { username: { type: "string" }, blockName: { type: "string" }, count: { type: "number" } }, required: ["blockName"] } }
    ,{ name: "harvestMatureCrops", description: "Harvest mature crops from farmland", inputSchema: { type: "object", properties: { username: { type: "string" }, count: { type: "number" } } } }
    ,{ name: "pickupItem", description: "Pick up items from the ground", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } } } }
    ,{ name: "craftItems", description: "Craft items using a crafting table", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } }
    ,{ name: "cookItem", description: "Cook items in a furnace", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "smeltItem", description: "Smelt items in a furnace", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "retrieveItemsFromNearbyFurnace", description: "Get smelted items from furnace", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "placeItemNearYou", description: "Place blocks near the bot", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "prepareLandForFarming", description: "Prepare land for farming", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "useItemOnBlockOrEntity", description: "Use items on blocks or entities", inputSchema: { type: "object", properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, userName: { type: "string" } } } }
    ,{ name: "rest", description: "Rest to regain health (wait)", inputSchema: { type: "object", properties: { ms: { type: "number" } } } }
    ,{ name: "sleepInNearbyBed", description: "Find and sleep in a bed", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "openNearbyChest", description: "Open a nearby chest", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "dance", description: "Make the bot dance", inputSchema: { type: "object", properties: { username: { type: "string" }, durationMs: { type: "number" } } } }
    ,{ name: "buildSomething", description: "Build structures using commands (op required)", inputSchema: { type: "object", properties: { username: { type: "string" }, commands: { type: "array", items: { type: "string" } } }, required: ["commands"] } }
    ,{ name: "depositItemsToNearbyChest", description: "Deposit items to nearby chest", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } }
    ,{ name: "withdrawItemsFromNearbyChest", description: "Withdraw items from nearby chest", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } }
    ,{ name: "digBlock", description: "Dig a block at coordinates", inputSchema: { type: "object", properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } }
    ,{ name: "placeBlockAt", description: "Place a block at coordinates", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["itemName","x","y","z"] } }
    ,{ name: "listInventory", description: "List inventory items", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "detectGamemode", description: "Detect current game mode", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "findBlock", description: "Find nearest block of a type", inputSchema: { type: "object", properties: { username: { type: "string" }, blockName: { type: "string" } }, required: ["blockName"] } }
    ,{ name: "findEntity", description: "Find nearest entity of a type", inputSchema: { type: "object", properties: { username: { type: "string" }, targetName: { type: "string" }, type: { type: "string" } } } }
  ];
  return { tools };
}

async function main() {
  log("server starting");
  const server = new Server({
    name: "minecraft-mcp-mineflayer",
    version: "0.1.0",
  }, {
    capabilities: { tools: {} },
  });

  // Notify client about tool availability after initialization
  server.oninitialized = () => {
    log("initialized; announcing tools list changed");
    server.sendToolListChanged().catch((e) => log("sendToolListChanged error", e));
  };

  server.onerror = (e) => log("protocol error", e);
  server.onclose = () => log("protocol closed");


  // Fallback request handler to ensure clients that call plain strings still get a response
  server.fallbackRequestHandler = async (request: any) => {
    const m = request?.method;
    log("fallback handler", m);
    if (m === "tools/list" || m === "list_tools") return listTools() as any;
    if (m === "tools/call" || m === "call_tool") return sendToolCall(request) as any;
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown method" }) }] } as any;
  };

  // Dynamically import the stdio transport at runtime to avoid ESM path mismatches
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  log("connecting via stdio...");
  await server.connect(transport);
  log("connected");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



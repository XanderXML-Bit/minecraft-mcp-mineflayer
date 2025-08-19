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

// Prevent process crashes on unexpected async errors
process.on('unhandledRejection', (err: any) => {
  try { log('unhandledRejection', err); } catch {}
});
process.on('uncaughtException', (err: any) => {
  try { log('uncaughtException', err); } catch {}
});

function getBotOrThrow(username?: string): Bot {
  if (username && bots.has(username)) return bots.get(username)!;
  if (username && !bots.has(username)) throw new Error(`Bot '${username}' not found`);
  const [first] = bots.values();
  if (!first) throw new Error("No active bots. Use joinGame first.");
  return first;
}

// Helpers
async function pathfindToPredicate(bot: Bot, predicate: (b: any) => boolean, maxDistance = 32, range = 1, timeoutMs = 45000) {
  const block = bot.findBlock({ matching: (b: any) => !!b && predicate(b), maxDistance });
  if (!block) throw new Error('Target not found nearby');
  const p: any = (block as any).position || block;
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, range));
  // wait until close enough or timeout
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dist = bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z));
    if (dist <= Math.max(1, range) + 0.5) break;
    await bot.waitForTicks(5);
  }
  if (Date.now() - start >= timeoutMs) throw new Error('navigation_timeout');
  return block as any;
}

// CollectBlock with timeout and safe cancellation
async function collectBlockWithTimeout(bot: Bot, block: any, timeoutMs = 30000) {
  let finished = false;
  const task = (bot as any).collectBlock.collect(block).then(() => { finished = true; });
  await Promise.race([
    task,
    new Promise((_, rej) => setTimeout(() => rej(new Error('collect_timeout')), timeoutMs))
  ]).catch(async (e) => {
    try { (bot as any).collectBlock?.cancelTask?.(); } catch {}
    throw e;
  });
}

function getStatus(bot: Bot) {
  const last = (bot as any).__lastDamage || null;
  const lastBroken = (bot as any).__lastBroken || null;
  const isDrowning = bot.oxygenLevel !== undefined && bot.oxygenLevel < 10;
  const effects = Object.values((bot as any).__effects || {}).map((e: any) => ({ id: e.id, amplifier: e.amplifier, duration: e.duration }));
  const env = {
    isInWater: !!(bot as any).isInWater,
    isOnGround: !!(bot.entity?.onGround),
    oxygenLevel: bot.oxygenLevel,
    isDrowning
  };
  // Clear lastBroken after reporting (one-shot)
  (bot as any).__lastBroken = null;
  // Clear lastDamage after reporting (one-shot)
  (bot as any).__lastDamage = null;
  return { health: bot.health, food: bot.food, lastDamage: last, lastBroken, effects, env };
}

function resolveBlockAliases(name: string, mcData: any): string[] {
  const n = name.toLowerCase();
  const all = Object.keys(mcData.blocksByName);
  if (n === 'log') return all.filter((b: string) => b.endsWith('_log'));
  if (n === 'bed') return all.filter((b: string) => b.includes('bed'));
  if (n === 'planks') return all.filter((b: string) => b.endsWith('_planks'));
  return all.filter((b: string) => b.includes(n));
}

// Durability helpers
function getItemDurabilityInfo(mcData: any, item: any) {
  if (!item) return null;
  const def = mcData?.itemsByName?.[item.name] || {};
  const max = def.maxDurability ?? def.durability ?? null;
  let used: number | null = (item as any).durabilityUsed ?? null;
  if (used == null) {
    const nbt: any = (item as any).nbt;
    const nbtDamage = nbt?.value?.Damage?.value ?? nbt?.Damage ?? null;
    if (nbtDamage != null) used = Number(nbtDamage);
  }
  if (max == null || used == null) return { max: max ?? null, used: used ?? null, left: max && used != null ? Math.max(0, max - used) : null };
  return { max, used, left: Math.max(0, max - used) };
}

function getEquippedSummary(bot: Bot) {
  const mcData = (bot as any).__mcdata;
  const held = bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count, durability: getItemDurabilityInfo(mcData, bot.heldItem) } : null;
  const slots: any = (bot.inventory as any)?.slots || [];
  const offItem = slots[45] || null;
  const offHand = offItem ? { name: offItem.name, count: offItem.count, durability: getItemDurabilityInfo(mcData, offItem) } : null;
  const headItem = slots[5] || null;
  const chestItem = slots[6] || null;
  const legsItem = slots[7] || null;
  const feetItem = slots[8] || null;
  const armor = {
    head: headItem ? { name: headItem.name, count: headItem.count, durability: getItemDurabilityInfo(mcData, headItem) } : null,
    chest: chestItem ? { name: chestItem.name, count: chestItem.count, durability: getItemDurabilityInfo(mcData, chestItem) } : null,
    legs: legsItem ? { name: legsItem.name, count: legsItem.count, durability: getItemDurabilityInfo(mcData, legsItem) } : null,
    feet: feetItem ? { name: feetItem.name, count: feetItem.count, durability: getItemDurabilityInfo(mcData, feetItem) } : null,
  };
  return { mainHand: held, offHand, armor };
}

async function raiseShieldFor(bot: Bot, durationMs: number) {
  try {
    // Ensure shield in off-hand
    const slots: any = (bot.inventory as any)?.slots || [];
    const off = slots[45];
    if (!off || off.name !== 'shield') {
      const shield = bot.inventory.items().find(i => i.name === 'shield');
      if (shield) await bot.equip(shield, 'off-hand');
    }
    // Hold use to raise shield
    // @ts-ignore
    bot.activateItem();
    await new Promise(r => setTimeout(r, durationMs));
  } finally {
    try {
      // @ts-ignore
      bot.deactivateItem();
    } catch {}
  }
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

  // Track status (health/food/damage) and provide self-defense hooks
  ;(bot as any).__lastHealth = bot.health;
  ;(bot as any).__lastFood = bot.food;
  ;(bot as any).__lastDamage = null;
  ;(bot as any).__selfDefense = { enabled: false };
  ;(bot as any).__autoShield = { enabled: true, durationMs: 800 };
  bot.on('health', () => {
    ;(bot as any).__lastHealth = bot.health;
    ;(bot as any).__lastFood = bot.food;
  });
  // Track effects
  ;(bot as any).__effects = {};
  bot.on('entityEffect', (entity: any, effect: any) => {
    if (entity === bot.entity) {
      (bot as any).__effects[effect.id] = { id: effect.id, amplifier: effect.amplifier, duration: effect.duration };
    }
  });
  bot.on('entityEffectEnd', (entity: any, effect: any) => {
    if (entity === bot.entity) {
      delete (bot as any).__effects[effect.id];
    }
  });
  bot.on('entityHurt', (entity: any, attacker: any) => {
    if (entity === bot.entity) {
      ;(bot as any).__lastDamage = {
        from: attacker?.name || attacker?.username || attacker?.displayName || 'unknown',
        time: Date.now()
      };
      const sd = (bot as any).__selfDefense;
      if (sd?.enabled && attacker) {
        // @ts-ignore
        bot.pvp.attack(attacker);
      }
      // Auto shield block
      const as = (bot as any).__autoShield;
      if (as?.enabled) {
        try { raiseShieldFor(bot, Number(as.durationMs ?? 800)); } catch {}
      }
    }
  });

  bot.once("login", async () => {
    // Configure auto eat
    try {
      // @ts-ignore
      bot.autoEat.options = { priority: "foodPoints", minHunger: 15 };
    } catch {}
    // Load mcData for durability checks
    try {
      const mcDataMod = await import('minecraft-data');
      const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
      (bot as any).__mcdata = mcData;
    } catch {}
    // Detect equipment/armor breaking via inventory slot updates
    try {
      const inv: any = (bot as any).inventory;
      if (inv?.on && !inv.__mcpListenerAttached) {
        inv.__mcpListenerAttached = true;
        inv.on('updateSlot', (slot: number, oldItem: any, newItem: any) => {
          try {
            if (oldItem && !newItem) {
              const mcData = (bot as any).__mcdata;
              const def = mcData?.itemsByName?.[oldItem.name];
              const hasDurability = !!(def?.maxDurability) || (oldItem?.nbt && (oldItem as any).nbt?.value?.Damage != null);
              if (hasDurability) {
                (bot as any).__lastBroken = { slot, itemName: oldItem.name, time: Date.now() };
              }
            }
          } catch {}
        });
      }
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

async function stopAllTasks(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  try { (bot as any).pvp?.stop?.(); } catch {}
  try { bot.pathfinder?.stop?.(); } catch {}
  // No direct API to stop statemachine; users should avoid starting it unless needed
  return { ok: true };
}

async function selfDefense(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const enable = Boolean(params.enable ?? true);
  (bot as any).__selfDefense = { enabled: enable };
  return { ok: true, enabled: enable };
}

async function autoShield(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const enable = Boolean((params as any).enable ?? true);
  const durationMs = Number((params as any).durationMs ?? 800);
  (bot as any).__autoShield = { enabled: enable, durationMs };
  return { ok: true, enabled: enable, durationMs };
}

async function raiseShield(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const ms = Number((params as any).durationMs ?? 800);
  await raiseShieldFor(bot, ms);
  return { ok: true };
}

async function lowerShield(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  try {
    // @ts-ignore
    bot.deactivateItem();
  } catch {}
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
  const maxMs = Number((params as any).maxMs ?? 120000);
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const candidates = resolveBlockAliases(blockName, mcData);
  const positions = bot.findBlocks({ matching: (b: any) => b && candidates.includes(b.name), maxDistance: 64, count });
  if (!positions.length) throw new Error(`No ${blockName} nearby`);
  const blocks = positions.map((v: any) => bot.blockAt(v)).filter(Boolean) as any[];
  let completed = 0; const failed: Array<{x:number,y:number,z:number, error?: string}> = [];
  const start = Date.now();
  for (const b of blocks) {
    if (Date.now() - start > maxMs) break;
    try {
      // Navigate near the block first to reduce path issues
      const p: any = (b as any).position || b;
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1));
      const navStart = Date.now();
      while (Date.now() - navStart < 20000) { const d = bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)); if (d <= 2.5) break; await bot.waitForTicks(5); }
      // @ts-ignore perform collect with timeout
      await collectBlockWithTimeout(bot, b, 30000);
      completed++;
    } catch (e: any) {
      const q: any = (b as any).position || b;
      failed.push({ x: q.x, y: q.y, z: q.z, error: String(e?.message || e) });
    }
  }
  const timedOut = Date.now() - start > maxMs;
  return { ok: completed > 0, requested: count, completed, remaining: Math.max(0, count - completed), failed, timedOut };
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
  let harvested = 0; const failed: Array<{x:number,y:number,z:number}> = [];
  const maxMs = Number((params as any).maxMs ?? 90000);
  const start = Date.now();
  for (const b of blocks) {
    if (Date.now() - start > maxMs) break;
    try {
      // @ts-ignore
      await bot.collectBlock.collect(b);
      harvested++;
    } catch {
      const p: any = (b as any).position || b;
      failed.push({ x: p.x, y: p.y, z: p.z });
    }
  }
  const timedOut = Date.now() - start > maxMs;
  return { ok: harvested > 0, harvested, failed, timedOut };
}

async function pickupItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = params.itemName ? String(params.itemName) : undefined;
  const ent = bot.nearestEntity((e: any) => e.type === 'object' && (!itemName || e.displayName === itemName));
  if (!ent) throw new Error('No dropped item found');
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalFollow(ent, 1));
  // wait up to 20 seconds to pick up and report partial
  const start = Date.now();
  const maxMs = Number((params as any).maxMs ?? 20000);
  let pickedUp = false;
  while (Date.now() - start < maxMs) {
    await bot.waitForTicks(5);
    if (!bot.nearestEntity((e: any) => e.id === ent.id)) { pickedUp = true; break; }
  }
  const timedOut = Date.now() - start >= maxMs;
  return { ok: pickedUp, pickedUp, timedOut };
}

async function openNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const pos = await pathfindToPredicate(bot, (b: any) => b?.name?.includes('chest'), 24, 2);
  const chest = await bot.openChest(pos as any);
  await bot.waitForTicks(10);
  const items = chest.containerItems().map((i: any) => ({ name: i.name, count: i.count }));
  chest.close();
  return { ok: true, chestItems: items };
}

async function craftItems(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || 'stick');
  const count = Number(params.count ?? 1);
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) throw new Error(`Unknown item ${itemName}`);
  // Initial recipe discovery to know if we need a table
  let initialRecipes = bot.recipesFor(item.id, null, 1, null);
  if (!initialRecipes || initialRecipes.length === 0) throw new Error('No recipe');
  const recipeNeedsTable = !!initialRecipes.find(r => (r as any).requiresTable);

  // Find or place a crafting table if needed
  let tableBlock: any = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 }) || null;
  if (recipeNeedsTable && !tableBlock) {
    const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (!tableItem) throw new Error('crafting_table required but not found nearby or in inventory');
    const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    if (!ref) throw new Error('No support block to place crafting_table');
    await bot.equip(tableItem, 'hand');
    await bot.placeBlock(ref as any, new Vec3(0, 1, 0));
    await bot.waitForTicks(2);
    const pos = bot.entity.position.floored().offset(0, 0, 1);
    tableBlock = bot.blockAt(pos as any);
  }

  // If using a table, path within 2 blocks so crafting UI opens reliably
  if (tableBlock) {
    const tp: any = (tableBlock as any).position || tableBlock;
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new goals.GoalNear(tp.x, tp.y, tp.z, 2));
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const d = bot.entity.position.distanceTo(new Vec3(tp.x, tp.y, tp.z));
      if (d <= 3) break;
      await bot.waitForTicks(5);
    }
  }

  // Refresh recipes with correct context
  let recipes = bot.recipesFor(item.id, null, 1, tableBlock || null);
  if (!recipes || recipes.length === 0) throw new Error('No recipe (context)');
  // Prefer a table recipe if we have a table; otherwise the first
  const recipe = (tableBlock && recipes.find(r => (r as any).requiresTable)) || recipes[0];

  function computeMissingFor(units: number) {
    try {
      const invMap: Record<number, number> = {};
      for (const it of bot.inventory.items()) invMap[it.type] = (invMap[it.type] || 0) + it.count;
      const reqMap: Record<number, number> = {};
      const r: any = recipe as any;
      // Shapeless recipes may provide ingredients
      if (Array.isArray(r.ingredients)) {
        for (const ing of r.ingredients) {
          if (!ing) continue;
          const id = Number(ing.id);
          const c = Number((ing.count ?? 1)) * units;
          reqMap[id] = (reqMap[id] || 0) + c;
        }
      }
      // Shaped recipes may provide inShape
      if (Array.isArray(r.inShape)) {
        for (const row of r.inShape) {
          if (!Array.isArray(row)) continue;
          for (const cell of row) {
            if (!cell) continue;
            const id = Number(cell.id);
            reqMap[id] = (reqMap[id] || 0) + 1 * units;
          }
        }
      }
      const missing: Array<{ id: number; name: string; count: number }> = [];
      for (const idStr of Object.keys(reqMap)) {
        const id = Number(idStr);
        const need = reqMap[id];
        const have = invMap[id] || 0;
        if (have < need) {
          const name = (mcData.items[id]?.name) || String(id);
          missing.push({ id, name, count: need - have });
        }
      }
      return missing;
    } catch {
      return [] as Array<{ id: number; name: string; count: number }>;
    }
  }

  function computeMaxCraftable(unitsLimit: number): { craftable: number; missing: Array<{ id: number; name: string; count: number }> } {
    try {
      const invMap: Record<number, number> = {};
      for (const it of bot.inventory.items()) invMap[it.type] = (invMap[it.type] || 0) + it.count;
      const r: any = recipe as any;
      const perUnitReq: Record<number, number> = {};
      if (Array.isArray(r.ingredients)) {
        for (const ing of r.ingredients) {
          if (!ing) continue; const id = Number(ing.id); const c = Number(ing.count ?? 1);
          perUnitReq[id] = (perUnitReq[id] || 0) + c;
        }
      }
      if (Array.isArray(r.inShape)) {
        for (const row of r.inShape) { if (!Array.isArray(row)) continue; for (const cell of row) { if (!cell) continue; const id = Number(cell.id); perUnitReq[id] = (perUnitReq[id] || 0) + 1; } }
      }
      let max = Number.isFinite(unitsLimit) ? unitsLimit : 64;
      for (const idStr of Object.keys(perUnitReq)) {
        const id = Number(idStr); const needPer = perUnitReq[id]; const have = invMap[id] || 0;
        max = Math.min(max, Math.floor(have / needPer));
      }
      const missing: Array<{ id: number; name: string; count: number }> = [];
      if (max <= 0) {
        for (const idStr of Object.keys(perUnitReq)) {
          const id = Number(idStr); const needPer = perUnitReq[id]; const have = invMap[id] || 0; if (have < needPer) {
            const name = (mcData.items[id]?.name) || String(id); missing.push({ id, name, count: needPer - have });
          }
        }
      }
      return { craftable: Math.max(0, Math.min(max, unitsLimit)), missing };
    } catch {
      return { craftable: 0, missing: [] };
    }
  }

  async function craftWithTimeout(amount: number, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // mineflayer doesn't support AbortSignal; use race
      await Promise.race([
        bot.craft(recipe, amount, tableBlock || null),
        new Promise((_, rej) => setTimeout(() => rej(new Error('craft_timeout')), timeoutMs))
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  let crafted = 0; const errors: string[] = [];
  const deadline = Date.now() + Number((params as any).maxMs ?? 60000);
  let reason: string | undefined;
  while (crafted < count && Date.now() < deadline) {
    const remaining = count - crafted;
    const { craftable, missing } = computeMaxCraftable(remaining);
    if (craftable <= 0) { reason = 'missing_resources'; errors.push('missing resources'); break; }
    try {
      await craftWithTimeout(craftable);
      crafted += craftable;
      continue;
    } catch (e: any) {
      errors.push(String(e?.message || e));
      if ((e && String(e.message).includes('timeout')) || String(e).includes('craft_timeout')) {
        reason = 'craft_timeout';
      }
      // Try one-by-one with small timeout to salvage
      try {
        await craftWithTimeout(1, 8000);
        crafted += 1;
      } catch (e2: any) {
        errors.push(String(e2?.message || e2));
        if (!reason && missing && missing.length > 0) reason = 'missing_resources';
        break;
      }
    }
    await bot.waitForTicks(1);
  }
  const timedOut = Date.now() >= deadline && crafted < count;
  if (!reason && recipeNeedsTable && !tableBlock) reason = 'missing_table';
  return { ok: crafted > 0, requested: count, crafted, remaining: Math.max(0, count - crafted), usedTable: !!tableBlock, timedOut, reason, missingItems: reason === 'missing_resources' ? computeMissingFor(count - crafted || 1) : [], errors };
}

// List recipes for a specific item and whether they are currently craftable
async function listRecipes(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || '');
  if (!itemName) throw new Error('itemName required');
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) throw new Error(`Unknown item ${itemName}`);
  const tableBlock: any = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 }) || null;
  const recipes = [
    ...bot.recipesFor(item.id, null, 1, null),
    ...(tableBlock ? bot.recipesFor(item.id, null, 1, tableBlock) : [])
  ];
  const unique = new Set<any>();
  const out: any[] = [];
  const invMap: Record<number, number> = {};
  for (const it of bot.inventory.items()) invMap[it.type] = (invMap[it.type] || 0) + it.count;
  for (const r of recipes) {
    if (unique.has(r)) continue; unique.add(r);
    const rec: any = r as any;
    const requiresTable = !!rec.requiresTable;
    const ingList: Array<{ id: number; name: string; count: number }> = [];
    const perUnitReq: Record<number, number> = {};
    if (Array.isArray(rec.ingredients)) {
      for (const ing of rec.ingredients) { if (!ing) continue; const id = Number(ing.id); const c = Number(ing.count ?? 1); perUnitReq[id] = (perUnitReq[id] || 0) + c; }
    }
    if (Array.isArray(rec.inShape)) {
      for (const row of rec.inShape) { if (!Array.isArray(row)) continue; for (const cell of row) { if (!cell) continue; const id = Number(cell.id); perUnitReq[id] = (perUnitReq[id] || 0) + 1; } }
    }
    for (const idStr of Object.keys(perUnitReq)) {
      const id = Number(idStr); const name = (mcData.items[id]?.name) || String(id); const cnt = perUnitReq[id]; ingList.push({ id, name, count: cnt });
    }
    // estimate craftable units with current inventory
    let max = 64;
    for (const idStr of Object.keys(perUnitReq)) { const id = Number(idStr); const need = perUnitReq[id]; const have = invMap[id] || 0; max = Math.min(max, Math.floor(have / need)); }
    const craftable = Math.max(0, max);
    out.push({ item: { id: item.id, name: item.name }, requiresTable, ingredients: ingList, craftable });
  }
  return { ok: true, item: item.name, recipes: out };
}

// ---- Cooking/Smelting helpers ----
function isLikelyFood(itemName: string): boolean {
  const n = itemName.toLowerCase();
  const foods = [
    'beef','porkchop','mutton','chicken','cod','salmon','rabbit','potato','kelp','sweet_berries'
  ];
  return foods.some(x => n.includes(x)) || n.startsWith('raw_') || n.includes('raw');
}

function isLikelyOre(itemName: string): boolean {
  const n = itemName.toLowerCase();
  if (n.endsWith('_ore')) return true;
  if (n.startsWith('raw_')) return true;
  return ['iron_ore','gold_ore','copper_ore','ancient_debris'].some(x => n.includes(x));
}

function chooseDeviceForItem(itemName: string, prefer?: string): 'furnace'|'smoker'|'blast_furnace'|'campfire' {
  const p = (prefer || '').toLowerCase();
  if (p === 'furnace' || p === 'smoker' || p === 'blast_furnace' || p === 'campfire') return p as any;
  if (isLikelyFood(itemName)) return 'smoker';
  if (isLikelyOre(itemName)) return 'blast_furnace';
  return 'furnace';
}

async function openFurnaceLike(bot: Bot, device: 'furnace'|'smoker'|'blast_furnace') {
  const pos = bot.findBlock({ matching: (b: any) => b?.name === device, maxDistance: 16 });
  if (!pos) throw new Error(`No ${device} nearby`);
  // mineflayer uses the same API for furnace/smoker/blast_furnace
  // @ts-ignore
  const f = await bot.openFurnace(pos as any);
  return f;
}

async function cookOrSmeltOnDevice(bot: Bot, device: 'furnace'|'smoker'|'blast_furnace', itemName: string, fuelName?: string) {
  const furnace: any = await openFurnaceLike(bot, device);
  try {
    try { await furnace.takeOutput(); } catch {}
    const inputItem = bot.inventory.items().find(i => i.name === itemName);
    if (!inputItem) throw new Error(`Missing input '${itemName}'`);
    if (!furnace.inputItem()) {
      await furnace.putInput(inputItem.type, null, 1);
    }
    if (!furnace.fuelItem()) {
      const fuel = fuelName ? bot.inventory.items().find(i => i.name === fuelName)
        : bot.inventory.items().find(i => ['coal','charcoal','coal_block','lava_bucket','stick','oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks','crimson_planks','warped_planks'].includes(i.name));
      if (!fuel) throw new Error('Missing fuel');
      await furnace.putFuel(fuel.type, null, 1);
    }
    // Wait up to 90s for an output
    const start = Date.now();
    let out: any = null;
    while (Date.now() - start < 90000) {
      await bot.waitForTicks(10);
      try {
        out = await furnace.takeOutput();
        if (out) break;
      } catch {}
    }
    const timedOut = !out;
    return { ok: !!out, output: out?.name, deviceUsed: device, timedOut };
  } finally {
    try { furnace.close(); } catch {}
  }
}

async function cookOnCampfire(bot: Bot, itemName: string) {
  const campfirePos = bot.findBlock({ matching: (b: any) => b?.name?.includes('campfire'), maxDistance: 16 });
  if (!campfirePos) throw new Error('No campfire nearby');
  const food = bot.inventory.items().find(i => i.name === itemName);
  if (!food) throw new Error(`Missing input '${itemName}'`);
  await bot.equip(food, 'hand');
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  const cp: any = (campfirePos as any).position || campfirePos;
  bot.pathfinder.setGoal(new goals.GoalNear(cp.x, cp.y, cp.z, 1));
  await bot.waitForTicks(10);
  const block = bot.blockAt(campfirePos as any);
  if (!block) throw new Error('Campfire vanished');
  await bot.activateBlock(block as any);
  const start = Date.now();
  const maxMs = 45000; // extend campfire wait to 45s for reliability
  while (Date.now() - start < maxMs) await bot.waitForTicks(10);
  // Try to pick up cooked item
  const endWait = Date.now() + 5000;
  while (Date.now() < endWait) {
    const ent = bot.nearestEntity((e: any) => e.type === 'object' && e.position.distanceTo((campfirePos as any)) <= 3);
    if (ent) {
      bot.pathfinder.setGoal(new goals.GoalFollow(ent, 1));
      await bot.waitForTicks(20);
      break;
    }
    await bot.waitForTicks(5);
  }
  const timedOut = Date.now() - start >= maxMs;
  return { ok: !timedOut, deviceUsed: 'campfire', timedOut };
}

async function smeltItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || 'iron_ore');
  const preferDevice = params.preferDevice ? String(params.preferDevice) : undefined;
  const fuelName = params.fuelName ? String(params.fuelName) : undefined;
  const device = chooseDeviceForItem(itemName, preferDevice);
  if (device === 'campfire') {
    return cookOnCampfire(bot, itemName);
  }
  return cookOrSmeltOnDevice(bot, device as any, itemName, fuelName);
}

async function cookItem(params: Record<string, unknown>) {
  return smeltItem(params);
}

async function cookWithSmoker(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || 'beef');
  const fuelName = params.fuelName ? String(params.fuelName) : undefined;
  return cookOrSmeltOnDevice(bot, 'smoker', itemName, fuelName);
}

async function smeltWithBlastFurnace(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || 'iron_ore');
  const fuelName = params.fuelName ? String(params.fuelName) : undefined;
  return cookOrSmeltOnDevice(bot, 'blast_furnace', itemName, fuelName);
}

async function cookWithCampfire(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || 'beef');
  return cookOnCampfire(bot, itemName);
}

async function retrieveItemsFromNearbyFurnace(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const furnacePos = bot.findBlock({ matching: (b: any) => b?.name === 'furnace' || b?.name === 'smoker' || b?.name === 'blast_furnace', maxDistance: 16 });
  if (!furnacePos) throw new Error('No furnace nearby');
  const furnace = await bot.openFurnace(furnacePos as any);
  let out: any = null;
  try { out = await furnace.takeOutput(); } catch {}
  furnace.close();
  return { ok: !!out, output: out?.name };
}

async function placeItemNearYou(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || 'cobblestone');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error('Item not in inventory');
  await bot.equip(item, 'hand');

  // Find nearest empty target cell adjacent to a solid face
  const origin = bot.entity.position.floored();
  const faces = [new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  let best: { target: any; ref: any; face: Vec3; dist: number } | null = null;
  const maxR = 3;
  for (let dx = -maxR; dx <= maxR; dx++) {
    for (let dy = -1; dy <= 2; dy++) {
      for (let dz = -maxR; dz <= maxR; dz++) {
        const pos = origin.offset(dx, dy, dz);
        // Avoid placing where the bot stands (feet or head)
        const feet = bot.entity.position.floored();
        const head = feet.offset(0, 1, 0);
        if ((pos.x === feet.x && pos.y === feet.y && pos.z === feet.z) || (pos.x === head.x && pos.y === head.y && pos.z === head.z)) continue;
        const here = bot.blockAt(pos);
        if (!here || here.boundingBox !== 'empty') continue;
        for (const f of faces) {
          const refPos = pos.minus(f);
          const ref = bot.blockAt(refPos);
          if (!ref) continue;
          const solid = ref.boundingBox === 'block' && !(ref as any).liquid;
          if (!solid) continue;
          const dist = bot.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z));
          if (!best || dist < best.dist) {
            best = { target: pos, ref: ref, face: f, dist };
          }
        }
      }
    }
  }
  if (!best) throw new Error('No nearby spot to place');

  // Move into placement range if too far
  if (best.dist > 4.5) {
    const movements = new Movements(bot);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new goals.GoalNear(best.ref.position.x, best.ref.position.y, best.ref.position.z, 2));
    const start = Date.now();
    while (Date.now() - start < 20000) { // wait up to 20s to get close
      const d = bot.entity.position.distanceTo(best.ref.position as any);
      if (d <= 4.5) break;
      await bot.waitForTicks(5);
    }
  }
  await bot.placeBlock(best.ref as any, best.face);
  return { ok: true, placedAt: { x: best.target.x, y: best.target.y, z: best.target.z } };
}

async function prepareLandForFarming(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const hoe = bot.inventory.items().find(i => i.name?.includes('hoe'));
  if (!hoe) throw new Error('No hoe in inventory');
  const radius = Number((params as any).radius ?? 3);
  const origin = bot.entity.position.floored();
  await bot.equip(hoe, 'hand');
  let tilled = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const x = origin.x + dx, z = origin.z + dz;
      const dirtPos = new Vec3(x, origin.y, z);
      const b = bot.blockAt(dirtPos);
      if (!b) continue;
      if (b.name === 'dirt' || b.name === 'grass_block') {
        await bot.activateBlock(b as any);
        tilled++;
        await bot.waitForTicks(1);
      }
    }
  }
  return { ok: true, tilled };
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
  const bedPos = await pathfindToPredicate(bot, (b: any) => b?.name?.includes('bed'), 24, 1);
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
  for (const c of cmds) {
    const cmd = c.trim().startsWith('/') ? c.trim() : `/${c.trim()}`;
    bot.chat(cmd);
  }
  return { ok: true };
}

async function depositItemsToNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || '');
  const count = params.count != null ? Number(params.count) : null;
  if (!itemName) throw new Error('itemName required');
  const chestPos = await pathfindToPredicate(bot, (b: any) => b?.name?.includes('chest'), 24, 2);
  const chest = await bot.openChest(chestPos as any);
  try {
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) throw new Error('Item not in inventory');
    await chest.deposit(item.type, null, count ?? item.count);
    const items = chest.containerItems().map((i: any) => ({ name: i.name, count: i.count }));
    return { ok: true, chestItems: items };
  } finally {
    chest.close();
  }
}

async function withdrawItemsFromNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || '');
  const count = params.count != null ? Number(params.count) : null;
  if (!itemName) throw new Error('itemName required');
  const chestPos = await pathfindToPredicate(bot, (b: any) => b?.name?.includes('chest'), 24, 2);
  const chest = await bot.openChest(chestPos as any);
  try {
    const mcDataMod = await import('minecraft-data');
    const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
    const item = mcData.itemsByName[itemName];
    if (!item) throw new Error(`Unknown item ${itemName}`);
    await chest.withdraw(item.id, null, count ?? 1);
    const items = chest.containerItems().map((i: any) => ({ name: i.name, count: i.count }));
    return { ok: true, chestItems: items };
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
  const equipped = getEquippedSummary(bot);
  return { ok: true, items, equipped };
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
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const candidates = resolveBlockAliases(name, mcData);
  const pos = bot.findBlock({ matching: (b: any) => b && candidates.includes(b.name), maxDistance: 64 });
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

// Follow and stopFollow
async function followPlayer(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const targetName = params.userName ? String(params.userName) : undefined;
  let target: any = null;
  if (targetName) target = bot.players[targetName]?.entity;
  if (!target) target = bot.nearestEntity((e: any) => e.type === 'player' && e.username !== bot.username);
  if (!target) throw new Error('No player to follow');
  const movements = new Movements(bot);
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalFollow(target, Number(params.distance ?? 2)));
  return { ok: true };
}

async function stopFollow(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  bot.pathfinder.stop();
  return { ok: true };
}

// Scan area for blocks/entities
async function scanArea(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const radius = Math.max(1, Math.min(8, Number((params as any).radius ?? 5)));
  const origin = bot.entity.position.floored();
  const blockCounts: Record<string, number> = {};
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -Math.min(4, radius); dy <= Math.min(4, radius); dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(new Vec3(origin.x + dx, origin.y + dy, origin.z + dz));
        if (!b) continue;
        if (b.boundingBox === 'empty') continue;
        blockCounts[b.name] = (blockCounts[b.name] || 0) + 1;
      }
    }
  }
  const entities = Object.values(bot.entities).filter((e: any) => e.position && e.position.distanceTo(bot.entity.position) <= radius + 2)
    .map((e: any) => ({ id: e.id, name: e.name || e.username || e.displayName, type: e.type }));
  return { ok: true, blocks: blockCounts, entities };
}

// Plant seeds within radius
async function plantSeedsWithinRadius(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const seedName = String((params as any).seedName ?? 'wheat_seeds');
  const radius = Number((params as any).radius ?? 3);
  const seed = bot.inventory.items().find(i => i.name === seedName);
  if (!seed) throw new Error('Seeds not in inventory');
  await bot.equip(seed, 'hand');
  const origin = bot.entity.position.floored();
  let planted = 0; const failed: Array<{x:number,y:number,z:number}> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const x = origin.x + dx, z = origin.z + dz;
      const pos = new Vec3(x, origin.y, z);
      const farmland = bot.blockAt(pos);
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (!farmland || !above) continue;
      if (farmland.name !== 'farmland') continue;
      if (above.boundingBox !== 'empty') continue;
      try {
        await bot.activateBlock(farmland as any);
        planted++;
        await bot.waitForTicks(1);
      } catch {
        failed.push({ x: pos.x, y: pos.y, z: pos.z });
      }
    }
  }
  return { ok: planted > 0, planted, failed };
}

async function stopAttack(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  try { (bot as any).pvp?.stop?.(); } catch {}
  return { ok: true };
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
  // Try ranged bow when far enough
  try {
    const rangedMin = 8; // fixed threshold for ranged attacks
    const bow = bot.inventory.items().find(i => i.name === 'bow');
    const hasArrow = !!bot.inventory.items().find(i => i.name.includes('arrow'));
    if (bow && hasArrow) {
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist > rangedMin) {
        await bot.equip(bow, 'hand');
        const aim = entity.position.offset(0, (entity as any).height ? (entity as any).height * 0.8 : 1.5, 0);
        await bot.lookAt(aim, true);
        // @ts-ignore
        bot.activateItem();
        await bot.waitForTicks(15);
        // @ts-ignore
        bot.deactivateItem();
      }
    }
  } catch {}
  // @ts-ignore
  bot.pvp.attack(entity);
  const maxMs = Number((params as any).maxMs ?? (params as any).duration ?? 60000);
  const start = Date.now();
  let result = 'timeout';
  while (Date.now() - start < maxMs) {
    await bot.waitForTicks(10);
    const still = Object.values(bot.entities).find((e: any) => e.id === entity.id);
    if (!still) { result = 'target_gone'; break; }
  }
  // @ts-ignore
  bot.pvp.stop();
  const timedOut = result === 'timeout';
  return { ok: !timedOut, result, timedOut };
}

async function openInventory(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const items = bot.inventory.items().map(i => ({ name: i.name, count: i.count, slot: i.slot }));
  const equipped = getEquippedSummary(bot);
  return { ok: true, items, equipped };
}

async function equipItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.name || params.itemName || "");
  const destination = String((params as any).destination || 'hand');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error(`Item '${itemName}' not found in inventory`);
  await bot.equip(item, destination as any);
  let durability: any = null;
  try {
    let mcData = (bot as any).__mcdata;
    if (!mcData) {
      const mcDataMod = await import('minecraft-data');
      mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
      (bot as any).__mcdata = mcData;
    }
    durability = getItemDurabilityInfo(mcData, item);
  } catch {}
  return { ok: true, destination, durability };
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
  let action: any = null;
  try {
    const name = (req as any).params.name as string;
    const args = ((req as any).params.arguments as any) ?? {};
    const botName = String(args.username || '');
    let statusBefore: any = null;
    try {
      const b = botName ? bots.get(botName) : undefined;
      statusBefore = b ? getStatus(b) : null;
    } catch {}
    switch (name) {
      case "joinGame": action = await joinGame(args); break;
      case "leaveGame": action = await leaveGame(args); break;
      case "goToSomeone": action = await goToSomeone(args); break;
      case "goToKnownLocation": action = await goToKnownLocation(args); break;
      case "sendChat": action = await sendChat(args); break;
      case "readChat": action = await readChat(args); break;
      case "attackSomeone": action = await attackSomeone(args); break;
      case "openInventory": action = await openInventory(args); break;
      case "equipItem": action = await equipItem(args); break;
      case "dropItem": action = await dropItem(args); break;
      case "giveItemToSomeone": action = await giveItemToSomeone(args); break;
      case "lookAround": action = await lookAround(args); break;
      case "eatFood": action = await eatFood(args); break;
      case "getPosition": action = await getPosition(args); break;
      case "lookAt": action = await lookAt(args); break;
      case "jump": action = await jump(args); break;
      case "moveInDirection": action = await moveInDirection(args); break;
      case "followPlayer": action = await followPlayer(args); break;
      case "stopFollow": action = await stopFollow(args); break;
      case "runAway": action = await runAway(args); break;
      case "swimToLand": action = await swimToLand(args); break;
      case "hunt": action = await hunt(args); break;
      case "mineResource": action = await mineResource(args); break;
      case "harvestMatureCrops": action = await harvestMatureCrops(args); break;
      case "pickupItem": action = await pickupItem(args); break;
      case "craftItems": action = await craftItems(args); break;
      case "listRecipes": action = await listRecipes(args); break;
      case "cookItem": action = await cookItem(args); break;
      case "smeltItem": action = await smeltItem(args); break;
      case "cookWithSmoker": action = await cookWithSmoker(args); break;
      case "smeltWithBlastFurnace": action = await smeltWithBlastFurnace(args); break;
      case "cookWithCampfire": action = await cookWithCampfire(args); break;
      case "retrieveItemsFromNearbyFurnace": action = await retrieveItemsFromNearbyFurnace(args); break;
      case "placeItemNearYou": action = await placeItemNearYou(args); break;
      case "prepareLandForFarming": action = await prepareLandForFarming(args); break;
      case "useItemOnBlockOrEntity": action = await useItemOnBlockOrEntity(args); break;
      case "rest": action = await rest(args); break;
      case "sleepInNearbyBed": action = await sleepInNearbyBed(args); break;
      case "openNearbyChest": action = await openNearbyChest(args); break;
      case "dance": action = await dance(args); break;
      case "buildSomething": action = await buildSomething(args); break;
      case "depositItemsToNearbyChest": action = await depositItemsToNearbyChest(args); break;
      case "withdrawItemsFromNearbyChest": action = await withdrawItemsFromNearbyChest(args); break;
      case "digBlock": action = await digBlock(args); break;
      case "placeBlockAt": action = await placeBlockAt(args); break;
      case "listInventory": action = await listInventory(args); break;
      case "detectGamemode": action = await detectGamemode(args); break;
      case "findBlock": action = await findBlock(args); break;
      case "findEntity": action = await findEntity(args); break;
      case "scanArea": action = await scanArea(args); break;
      case "plantSeedsWithinRadius": action = await plantSeedsWithinRadius(args); break;
      case "stopAttack": action = await stopAttack(args); break;
      case "stopAllTasks": action = await stopAllTasks(args); break;
      case "selfDefense": action = await selfDefense(args); break;

      default:
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Unknown tool" }) }] };
    }
    // attach status and deltas
    try {
      const b = botName ? bots.get(botName) : undefined;
      const after = b ? getStatus(b) : null;
      const delta = after && statusBefore ? {
        healthDelta: after.health - statusBefore.health,
        foodDelta: after.food - statusBefore.food,
        lastDamage: after.lastDamage
      } : undefined;
      return { content: [{ type: "text", text: JSON.stringify({ ...(action || { ok: true }), bot: botName || undefined, status: after, delta }) }] };
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ ...(action || { ok: true }), bot: botName || undefined }) }] };
    }
  } catch (e: any) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e?.message || e) }) }] };
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
    { name: "equipItem", description: "Equip armor, tools, or weapons", inputSchema: { type: "object", properties: { username: { type: "string" }, name: { type: "string" }, destination: { type: "string", enum: ["hand","off-hand","head","torso","legs","feet"] } }, required: ["name"] } },
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
    ,{ name: "followPlayer", description: "Follow the nearest or specified player", inputSchema: { type: "object", properties: { username: { type: "string" }, userName: { type: "string" }, distance: { type: "number" } } } }
    ,{ name: "stopFollow", description: "Stop following", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "runAway", description: "Run away from threats", inputSchema: { type: "object", properties: { username: { type: "string" }, distance: { type: "number" } } } }
    ,{ name: "swimToLand", description: "Swim to nearest land when in water", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "hunt", description: "Hunt animals or mobs", inputSchema: { type: "object", properties: { username: { type: "string" }, targetName: { type: "string" }, duration: { type: "number" } } } }
    ,{ name: "mineResource", description: "Mine specific blocks or resources", inputSchema: { type: "object", properties: { username: { type: "string" }, blockName: { type: "string" }, count: { type: "number" } }, required: ["blockName"] } }
    ,{ name: "harvestMatureCrops", description: "Harvest mature crops from farmland", inputSchema: { type: "object", properties: { username: { type: "string" }, count: { type: "number" } } } }
    ,{ name: "pickupItem", description: "Pick up items from the ground", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } } } }
    ,{ name: "craftItems", description: "Craft items using a crafting table", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } }
    ,{ name: "listRecipes", description: "List recipes for an item and how many are craftable with current inventory", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "cookItem", description: "Cook items in a furnace", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "smeltItem", description: "Smelt items in a furnace", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "cookWithSmoker", description: "Cook items in a smoker (optimized for food)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "smeltWithBlastFurnace", description: "Smelt items in a blast furnace (optimized for ores)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "cookWithCampfire", description: "Cook items on a campfire (no fuel, slower)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } }, required: ["itemName"] } }
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
    ,{ name: "scanArea", description: "Scan blocks/entities within radius", inputSchema: { type: "object", properties: { username: { type: "string" }, radius: { type: "number" } } } }
    ,{ name: "plantSeedsWithinRadius", description: "Plant seeds in radius", inputSchema: { type: "object", properties: { username: { type: "string" }, seedName: { type: "string" }, radius: { type: "number" } } } }
    ,{ name: "stopAttack", description: "Stop current attack", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    
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
  server.onclose = () => {
    log("protocol closed");
  };


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
  // Proactively announce tools once connected (some clients rely on this)
  try {
    log("sending tool list changed notification");
    await server.sendToolListChanged();
  } catch (e) {
    log("sendToolListChanged post-connect error", e as any);
  }
  // Keepalive: periodically re-announce tools to keep some clients from idling out
  setInterval(() => {
    server.sendToolListChanged().catch(() => {});
  }, 120000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



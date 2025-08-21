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

// Per-bot task mutex and cancellation
function getTask(bot: Bot) {
  if (!(bot as any).__task) (bot as any).__task = { running: false, abort: null as null | (() => void) };
  return (bot as any).__task as { running: boolean; abort: null | (() => void) };
}
async function withTask<T>(bot: Bot, fn: (signal: { aborted: boolean; onAbort(cb: () => void): void }) => Promise<T>): Promise<T> {
  const task = getTask(bot);
  if (task.running) throw new Error('another_task_running');
  task.running = true;
  let aborted = false;
  const onAbortCbs: Array<() => void> = [];
  task.abort = () => { aborted = true; for (const cb of onAbortCbs) { try { cb(); } catch {} } };
  try {
    const res = await fn({ aborted, onAbort(cb) { onAbortCbs.push(cb); } });
    return res;
  } finally {
    task.running = false;
    task.abort = null;
  }
}

function configureMovementsDefaults(movements: any) {
  try {
    movements.allowParkour = false;
    movements.allowSprinting = true;
    movements.canDig = true;
    movements.maxDropDown = Math.min(3, movements.maxDropDown ?? 3);
    // Prefer dry ground over liquids
    (movements as any).liquidCost = 25;
  } catch {}
  return movements;
}

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
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, range));
  // wait until close enough or timeout
  const start = Date.now();
  const idleMs = 15000;
  let lastProgressAt = start;
  let best = Infinity;
  while (Date.now() - start < timeoutMs) {
    const dist = bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z));
    if (dist <= Math.max(1, range) + 0.5) break;
    if (dist + 0.25 < best) { best = dist; lastProgressAt = Date.now(); }
    if (Date.now() - lastProgressAt > idleMs) throw new Error('navigation_stalled');
    await bot.waitForTicks(5);
  }
  if (Date.now() - start >= timeoutMs) throw new Error('navigation_timeout');
  return block as any;
}

// Combat/tool helpers
function hasArrows(bot: Bot): boolean {
  return bot.inventory.items().some(i => i.name.includes('arrow'));
}

async function equipBowIfAvailable(bot: Bot): Promise<boolean> {
  const bow = bot.inventory.items().find(i => i.name === 'bow');
  if (bow && hasArrows(bot)) { pushSuspendAutoEat(bot); try { await bot.equip(bow, 'hand'); } finally { popSuspendAutoEat(bot); } return true; }
  return false;
}

async function equipBestMeleeWeapon(bot: Bot): Promise<boolean> {
  const preference = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','golden_sword','wooden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe'
  ];
  for (const name of preference) {
    const it = bot.inventory.items().find(i => i.name === name);
    if (it) { await bot.equip(it, 'hand'); return true; }
  }
  return false;
}

async function equipBestToolForBlock(bot: Bot, block: any): Promise<boolean> {
  try { if ((bot as any).tool?.equipForBlock) { await (bot as any).tool.equipForBlock(block); return true; } } catch {}
  // Heuristic fallback by block name
  try {
    const n = String(block?.name || '').toLowerCase();
    const pick = ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','golden_pickaxe','wooden_pickaxe'];
    const axe = ['netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe'];
    const shovel = ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','golden_shovel','wooden_shovel'];
    const hoe = ['netherite_hoe','diamond_hoe','iron_hoe','stone_hoe','golden_hoe','wooden_hoe'];
    const pickTargets = ['ore','stone','deepslate','cobblestone','obsidian','netherrack','end_stone','andesite','granite','diorite'];
    const axeTargets = ['log','planks','wood','stem','hyphae'];
    const shovelTargets = ['dirt','sand','gravel','snow','clay','soul_sand','soul_soil'];
    const hoeTargets = ['leaves','hay','wheat','carrots','potatoes','beetroots'];
    const equipFromList = async (names: string[]) => {
      for (const nm of names) { const it = bot.inventory.items().find(i => i.name === nm); if (it) { pushSuspendAutoEat(bot); try { await bot.equip(it, 'hand'); } finally { popSuspendAutoEat(bot); } return true; } }
      return false;
    };
    if (pickTargets.some(t => n.includes(t))) return await equipFromList(pick);
    if (axeTargets.some(t => n.includes(t))) return await equipFromList(axe);
    if (shovelTargets.some(t => n.includes(t))) return await equipFromList(shovel);
    if (hoeTargets.some(t => n.includes(t))) return await equipFromList(hoe);
  } catch {}
  return false;
}

function requiredToolCategoryForBlockName(name: string): 'pickaxe'|'axe'|'shovel'|'hoe'|null {
  const n = name.toLowerCase();
  const pickTargets = ['ore','stone','deepslate','cobblestone','obsidian','netherrack','end_stone','andesite','granite','diorite'];
  const axeTargets = ['log','planks','wood','stem','hyphae'];
  const shovelTargets = ['dirt','sand','gravel','snow','clay','soul_sand','soul_soil'];
  const hoeTargets = ['leaves','hay','wheat','carrots','potatoes','beetroots'];
  if (pickTargets.some(t => n.includes(t))) return 'pickaxe';
  if (axeTargets.some(t => n.includes(t))) return 'axe';
  if (shovelTargets.some(t => n.includes(t))) return 'shovel';
  if (hoeTargets.some(t => n.includes(t))) return 'hoe';
  return null;
}

function inventoryHasToolCategory(bot: Bot, category: 'pickaxe'|'axe'|'shovel'|'hoe'): boolean {
  const tools: Record<'pickaxe'|'axe'|'shovel'|'hoe', string[]> = {
    pickaxe: ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','golden_pickaxe','wooden_pickaxe'],
    axe: ['netherite_axe','diamond_axe','iron_axe','stone_axe','golden_axe','wooden_axe'],
    shovel: ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','golden_shovel','wooden_shovel'],
    hoe: ['netherite_hoe','diamond_hoe','iron_hoe','stone_hoe','golden_hoe','wooden_hoe']
  };
  const list = tools[category] as string[];
  return bot.inventory.items().some(i => list.includes(i.name));
}

// CollectBlock with timeout and safe cancellation (avoid unhandled rejections)
async function collectBlockWithTimeout(bot: Bot, block: any, timeoutMs = 30000) {
  const rawTask: Promise<any> = (bot as any).collectBlock.collect(block);
  // Attach catch so rejections are handled even if we time out
  const guardedTask = rawTask.catch((e) => { throw e; });
  try {
    await Promise.race([
      guardedTask,
      new Promise((_, rej) => setTimeout(() => rej(new Error('collect_timeout')), timeoutMs))
    ]);
  } catch (e) {
    try { (bot as any).collectBlock?.cancelTask?.(); } catch {}
    // Ensure any late rejections are consumed
    try { rawTask.catch(() => {}); } catch {}
    throw e;
  }
}

// Dig with timeout and safe cancellation
async function digBlockWithTimeout(bot: Bot, block: any, timeoutMs = 30000) {
  let finished = false;
  const digging = bot.dig(block as any).then(() => { finished = true; });
  try {
    await Promise.race([
      digging,
      new Promise((_, rej) => setTimeout(() => {
        try { (bot as any).stopDigging?.(); } catch {}
        rej(new Error('dig_timeout'));
      }, timeoutMs))
    ]);
  } finally {
    // Ensure we consume any late rejections
    try { (digging as any).catch?.(() => {}); } catch {}
  }
}

// Suspend auto-eat helper (reference-counted)
function pushSuspendAutoEat(bot: Bot) {
  const c = Number((bot as any).__suspendAutoEatCount || 0);
  (bot as any).__suspendAutoEatCount = c + 1;
  (bot as any).__suspendAutoEat = true;
}
function popSuspendAutoEat(bot: Bot) {
  try {
    const c = Number((bot as any).__suspendAutoEatCount || 0);
    const n = Math.max(0, c - 1);
    (bot as any).__suspendAutoEatCount = n;
    (bot as any).__suspendAutoEat = n > 0;
  } catch {}
}

function getStatus(bot: Bot) {
  const last = (bot as any).__lastDamage || null;
  const lastBroken = (bot as any).__lastBroken || null;
  const lastDefense = (bot as any).__lastDefense || null;
  const lastDeath = (bot as any).__lastDeath || null;
  const lastHungerWarning = (bot as any).__lastHungerWarning || null;
  const isDrowning = bot.oxygenLevel !== undefined && bot.oxygenLevel < 10;
  const effects = Object.values((bot as any).__effects || {}).map((e: any) => ({ id: e.id, amplifier: e.amplifier, duration: e.duration }));
  const pos = bot.entity?.position;
  const posObj = pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined;
  // Time of day
  let timeOfDay: number | undefined;
  let isDay: boolean | undefined;
  try {
    const t = (bot as any).time?.timeOfDay ?? (bot as any).time?.time ?? undefined;
    if (typeof t === 'number') {
      timeOfDay = t % 24000;
      isDay = timeOfDay < 12000;
    }
  } catch {}
  // Biome name if available
  let biome: string | undefined;
  try {
    const feet = bot.blockAt(bot.entity.position.floored());
    const biomeId = (feet as any)?.biome?.id ?? (feet as any)?.biome;
    const mcData = (bot as any).__mcdata;
    if (mcData && biomeId != null) {
      const b = (mcData as any).biomes?.[biomeId];
      biome = b?.name ?? String(biomeId);
    }
  } catch {}
  // Area classification
  let area: 'outside'|'underground'|'in_water'|'underwater'|undefined;
  const isInWater = !!(bot as any).isInWater;
  const underwater = isInWater && (bot.oxygenLevel != null) && bot.oxygenLevel < 20;
  if (underwater) area = 'underwater';
  else if (isInWater) area = 'in_water';
  else {
    try {
      const head = bot.entity.position.floored().offset(0, 1, 0);
      let clearAbove = true;
      for (let dy = 0; dy < 20; dy++) {
        const b = bot.blockAt(head.offset(0, dy, 0));
        if (b && b.boundingBox !== 'empty') { clearAbove = false; break; }
      }
      area = clearAbove ? 'outside' : 'underground';
    } catch {}
  }
  const env = {
    position: posObj,
    timeOfDay,
    isDay,
    biome,
    area,
    isInWater,
    isOnGround: !!(bot.entity?.onGround),
    oxygenLevel: bot.oxygenLevel,
    isDrowning
  };
  // Clear lastBroken after reporting (one-shot)
  (bot as any).__lastBroken = null;
  // Clear lastDamage after reporting (one-shot)
  (bot as any).__lastDamage = null;
  // Clear lastDefense after reporting (one-shot)
  (bot as any).__lastDefense = null;
  // Clear lastDeath after reporting (one-shot)
  (bot as any).__lastDeath = null;
  // Clear hunger warning after reporting (one-shot)
  (bot as any).__lastHungerWarning = null;
  return { health: bot.health, food: bot.food, lastDamage: last, lastBroken, lastDefense, lastDeath, lastHungerWarning, effects, env };
}

function resolveBlockAliases(name: string, mcData: any): string[] {
  const n = name.toLowerCase();
  const all = Object.keys(mcData.blocksByName);
  if (n === 'log') return all.filter((b: string) => b.endsWith('_log'));
  if (n === 'bed') return all.filter((b: string) => b.includes('bed'));
  if (n === 'planks') return all.filter((b: string) => b.endsWith('_planks'));
  return all.filter((b: string) => b.includes(n));
}

function isWaterLike(block: any): boolean {
  if (!block) return false;
  const n = String(block.name || '').toLowerCase();
  // Vanilla hydration: only true water blocks hydrate farmland
  return n === 'water';
}

function isPlantObstruction(name: string): boolean {
  const n = name.toLowerCase();
  if (n === 'grass' || n === 'tall_grass' || n === 'fern' || n === 'large_fern' || n === 'dead_bush') return true;
  const flowers = ['flower','dandelion','poppy','orchid','allium','azure_bluet','oxeye_daisy','cornflower','lily_of_the_valley','wither_rose','tulip','sunflower','lilac','rose_bush','peony'];
  return flowers.some(f => n.includes(f));
}

function isClearToSkyAt(bot: Bot, pos: Vec3): boolean {
  try {
    for (let dy = 1; dy <= 20; dy++) {
      const b = bot.blockAt(new Vec3(pos.x, pos.y + dy, pos.z));
      if (b && b.boundingBox !== 'empty') return false;
    }
    return true;
  } catch {
    return false;
  }
}

function deriveDroppedItemInfo(entity: any, mcData: any): { id?: number; name?: string; count?: number } | null {
  try {
    const md = entity?.metadata;
    if (md && typeof md === 'object') {
      // Look for fields that resemble item info across versions
      // Common patterns: { itemId, itemCount } or { item: { id, count } }
      let id: number | undefined;
      let count: number | undefined;
      if (md.itemId != null) id = Number(md.itemId);
      if (md.itemCount != null) count = Number(md.itemCount);
      // Search nested objects
      for (const key of Object.keys(md)) {
        const val: any = (md as any)[key];
        if (val && typeof val === 'object') {
          if (val.itemId != null && id == null) id = Number(val.itemId);
          if (val.itemCount != null && count == null) count = Number(val.itemCount);
          if (val.id != null && id == null) id = Number(val.id);
          if (val.count != null && count == null) count = Number(val.count);
        }
      }
      const name = id != null ? (mcData?.items?.[id]?.name ?? mcData?.itemsByName?.[id]?.name) : undefined;
      return { id, name, count };
    }
  } catch {}
  return null;
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
      if (shield) { pushSuspendAutoEat(bot); try { await bot.equip(shield, 'off-hand'); } finally { popSuspendAutoEat(bot); } }
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
  ;(bot as any).__selfDefense = { enabled: true, durationMs: 10000 };
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
        try {
          // Retaliate briefly without permanently hijacking state (equip best)
          (async () => {
            const dist = bot.entity.position.distanceTo(attacker.position || bot.entity.position);
            if (!(await equipBowIfAvailable(bot)) || dist <= 8) {
              await equipBestMeleeWeapon(bot);
            }
          })().catch(() => {});
          // @ts-ignore
          bot.pvp.attack(attacker);
          const sdMs = Number(((bot as any).__selfDefense?.durationMs) ?? 10000);
          setTimeout(() => { try { (bot as any).pvp?.stop?.(); } catch {} }, sdMs);
          (bot as any).__lastDefense = { target: attacker?.name || attacker?.username || 'unknown', time: Date.now() };
        } catch {}
      }
      // Auto shield block
      const as = (bot as any).__autoShield;
      if (as?.enabled) {
        try { raiseShieldFor(bot, Number(as.durationMs ?? 800)); } catch {}
      }
    }
  });

  // Track death info (position, cause)
  try {
    bot.on('death', () => {
      const pos = bot.entity?.position?.clone?.() || bot.entity?.position;
      (bot as any).__lastDeath = {
        position: pos ? { x: pos.x, y: pos.y, z: pos.z } : undefined,
        time: Date.now(),
        cause: (bot as any).lastDeathCause || 'unknown'
      };
      // Persist last death position for return tool
      (bot as any).__lastDeathPosition = (bot as any).__lastDeath?.position;
    });
    bot.on('message', (jsonMsg: any) => {
      const text = jsonMsg?.toString?.() ?? String(jsonMsg?.text ?? "");
      // Heuristic: capture death-related messages as cause
      if (/slain|fell|doomed|burned|drowned|blew up|pricked|shot/i.test(text)) {
        (bot as any).lastDeathCause = text;
      }
    });
  } catch {}

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

    // Inherent auto-eat with warnings when hungry and no food
    try {
      const hungerThreshold = 15;
      ;(bot as any).__autoEatCfg = { enabled: true, threshold: hungerThreshold, warnCooldownMs: 30000, lastWarnAt: 0, lastTriedAt: 0, isEating: false };
      // @ts-ignore
      if ((bot as any).autoEat) (bot as any).autoEat.options = { priority: "foodPoints", minHunger: hungerThreshold };
      ;(bot as any).__autoEatInterval = setInterval(async () => {
        try {
          if (!(bot as any).__autoEatCfg?.enabled) return;
          if (!bot.entity) return;
          if (bot.food >= hungerThreshold) return;
          if ((bot as any).__suspendAutoEat) return;
          const now = Date.now();
          if ((bot as any).__autoEatCfg.isEating) return;
          (bot as any).__autoEatCfg.lastTriedAt = now;
          const hasFood = bot.inventory.items().some((i: any) => isLikelyFood(i.name || ""));
          if (hasFood) {
            try {
              (bot as any).__autoEatCfg.isEating = true;
              // @ts-ignore
              await bot.autoEat?.eat?.();
            } catch (e) {
              const stillHasFood = bot.inventory.items().some((i: any) => isLikelyFood(i.name || ""));
              if (!stillHasFood && now - ((bot as any).__autoEatCfg.lastWarnAt || 0) > (bot as any).__autoEatCfg.warnCooldownMs) {
                (bot as any).__lastHungerWarning = { needed: hungerThreshold, current: bot.food, time: now };
                (bot as any).__autoEatCfg.lastWarnAt = now;
              }
            } finally {
              (bot as any).__autoEatCfg.isEating = false;
            }
          } else {
            if (now - ((bot as any).__autoEatCfg.lastWarnAt || 0) > (bot as any).__autoEatCfg.warnCooldownMs) {
              (bot as any).__lastHungerWarning = { needed: hungerThreshold, current: bot.food, time: now };
              (bot as any).__autoEatCfg.lastWarnAt = now;
            }
          }
        } catch {}
      }, 2000);
    } catch {}

    // Projectile-aware auto-shield: briefly raise shield when projectiles are nearby
    try {
      ;(bot as any).__shieldScan = setInterval(() => {
        try {
          const as = (bot as any).__autoShield;
          if (!as?.enabled) return;
          const now = Date.now();
          const last = (bot as any).__shieldLastRaised || 0;
          if (now - last < 600) return;
          const near = Object.values(bot.entities).some((e: any) => {
            if (!e || !e.position) return false;
            const n = String(e.name || e.displayName || '').toLowerCase();
            // Common projectile names across versions
            const isProj = n.includes('arrow') || n.includes('trident') || n.includes('snowball') || n.includes('fireball') || n.includes('projectile');
            if (!isProj) return false;
            return e.position.distanceTo(bot.entity.position) <= 6;
          });
          if (near) {
            (bot as any).__shieldLastRaised = now;
            raiseShieldFor(bot, Number(as.durationMs ?? 800)).catch(() => {});
          }
        } catch {}
      }, 400);
    } catch {}
  });

  bot.on("end", () => {
    try { clearInterval((bot as any).__autoEatInterval); } catch {}
    try { clearInterval((bot as any).__shieldScan); } catch {}
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
  const maxMs = Number((params as any).maxMs ?? 60000);
  const mcDataMod = await import("minecraft-data");
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, range));
  const target = new Vec3(x, y, z);
  const start = Date.now();
  let arrived = false;
  let lastProgressAt = start;
  let best = Infinity;
  while (Date.now() - start < maxMs) {
    const d = bot.entity.position.distanceTo(target);
    if (d <= Math.max(1, range) + 0.5) { arrived = true; break; }
    if (d + 0.25 < best) { best = d; lastProgressAt = Date.now(); }
    if (Date.now() - lastProgressAt > 15000) break; // stalled
    await bot.waitForTicks(5);
  }
  try { bot.pathfinder.stop(); } catch {}
  const dist = bot.entity.position.distanceTo(target);
  return { ok: arrived, arrived, distance: dist, timedOut: !arrived };
}

async function goToSomeone(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const targetName = String(params.userName || params.username || "");
  const player = bot.players[targetName]?.entity;
  if (!player) throw new Error(`Player '${targetName}' not found`);
  const mcDataMod = await import("minecraft-data");
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const movements = configureMovementsDefaults(new Movements(bot));
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
  try { const t = (bot as any).__task; if (t?.abort) t.abort(); } catch {}
  // No direct API to stop statemachine; users should avoid starting it unless needed
  return { ok: true };
}

// selfDefense tool removed; self-defense is always enabled by default and reported via status.lastDefense one-shot

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
  const movements = configureMovementsDefaults(new Movements(bot));
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
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(found.x, found.y, found.z, 1));
  return { ok: true };
}

async function hunt(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const targetKey = String(params.targetName || params.targetType || 'cow');
  const countTarget = Math.max(1, Number((params as any).count ?? 1));
  const maxMs = Number((params as any).maxMs ?? 120000);
  const stallMs = 20000;
  let kills = 0; const errors: string[] = [];
  const start = Date.now();
  let lastProgressAt = start;

  const matches = (e: any) => (e && (e.name === targetKey || e.displayName === targetKey || e.kind === targetKey));

  while (kills < countTarget && Date.now() - start < maxMs) {
    // Acquire target
    let ent: any = bot.nearestEntity(matches);
    const acquireStart = Date.now();
    while (!ent && Date.now() - acquireStart < 10000) { await bot.waitForTicks(5); ent = bot.nearestEntity(matches); }
    if (!ent) { errors.push('no_target_found'); break; }

    try {
      const dist = bot.entity.position.distanceTo(ent.position);
      if (!(await equipBowIfAvailable(bot)) || dist <= 8) {
        await equipBestMeleeWeapon(bot);
      }
    } catch {}

    // Attack and wait for outcome
    const targetId = ent.id;
    let dead = false;
    const onDead = (entity: any) => { if (entity?.id === targetId) dead = true; };
    try { bot.on('entityDead', onDead as any); } catch {}
    try {
      // @ts-ignore
      bot.pvp.attack(ent);
      const fightStart = Date.now();
      while (Date.now() - fightStart < 30000) {
        await bot.waitForTicks(5);
        if (dead) break;
        const still = Object.values(bot.entities).find((e: any) => e.id === targetId);
        if (!still) { // out of range or dead
          // give a brief grace to get death event
          const grace = Date.now() + 1000;
          while (!dead && Date.now() < grace) { await bot.waitForTicks(2); }
          break;
        }
      }
    } finally {
      try { (bot as any).pvp?.stop?.(); } catch {}
      try { bot.removeListener('entityDead', onDead as any); } catch {}
    }

    if (dead) {
      kills++;
      lastProgressAt = Date.now();
      continue;
    } else {
      errors.push('target_escaped_or_timeout');
    }

    if (Date.now() - lastProgressAt > stallMs) break;
  }

  const timedOut = kills < countTarget && Date.now() - start >= maxMs;
  const stalled = kills < countTarget && Date.now() - lastProgressAt > stallMs;
  return { ok: kills > 0, requested: countTarget, kills, remaining: Math.max(0, countTarget - kills), timedOut, stalled, errors };
}

async function mineResource(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const blockName = String(params.blockName || params.resource || 'stone');
  const count = Number(params.count ?? 1);
  const maxMs = Number((params as any).maxMs ?? 120000);
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const candidates = resolveBlockAliases(blockName, mcData);
  const positions = bot.findBlocks({ matching: (b: any) => b && candidates.includes(b.name), maxDistance: 64, count });
  if (!positions.length) throw new Error(`No ${blockName} nearby`);
  const blocks = positions.map((v: any) => bot.blockAt(v)).filter(Boolean) as any[];
  // Pre-check required tool category
  const needCat = requiredToolCategoryForBlockName(blocks[0]?.name || blockName);
  if (needCat && !inventoryHasToolCategory(bot, needCat)) {
    return { ok: false, requested: count, completed: 0, remaining: count, reason: 'missing_tool', needed: needCat };
  }
  let completed = 0; const failed: Array<{x:number,y:number,z:number, error?: string}> = [];
  const start = Date.now();
  let lastProgressAt = start;
  for (const b of blocks) {
    if (Date.now() - start > maxMs) break;
    try {
      // Navigate near the block first to reduce path issues
      const p: any = (b as any).position || b;
      // Per-block tool check to avoid timeouts on unmineable blocks
      const need = requiredToolCategoryForBlockName((b as any).name || '');
      if (need && !inventoryHasToolCategory(bot, need)) {
        failed.push({ x: p.x, y: p.y, z: p.z, error: `missing_tool:${need}` });
        continue;
      }
      await equipBestToolForBlock(bot, b);
      const movements = configureMovementsDefaults(new Movements(bot));
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1));
      const navStart = Date.now();
      while (Date.now() - navStart < 20000) { const d = bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)); if (d <= 2.5) break; await bot.waitForTicks(5); }
      // @ts-ignore perform collect with timeout
      try { pushSuspendAutoEat(bot); await collectBlockWithTimeout(bot, b, 30000); } finally { popSuspendAutoEat(bot); }
      completed++;
      lastProgressAt = Date.now();
    } catch (e: any) {
      const q: any = (b as any).position || b;
      failed.push({ x: q.x, y: q.y, z: q.z, error: String(e?.message || e) });
    }
    if (Date.now() - lastProgressAt > 20000) break; // stall protection
  }
  const timedOut = Date.now() - start > maxMs;
  const stalled = Date.now() - lastProgressAt > 20000 && !timedOut && completed < count;
  return { ok: completed > 0, requested: count, completed, remaining: Math.max(0, count - completed), failed, timedOut, stalled };
  });
}

async function harvestMatureCrops(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const crops = ['wheat', 'carrots', 'potatoes', 'beetroots'];
  const want = Math.max(1, Number((params as any).count ?? 8));
  // Dynamic scan for candidate crop blocks around bot within radius
  const radius = 16;
  const origin = bot.entity.position.floored();
  const blocks: any[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const p = new Vec3(origin.x + dx, origin.y + dy, origin.z + dz);
        const b = bot.blockAt(p);
        if (!b) continue;
        if (!crops.includes(b.name)) continue;
        const age = (b as any).getProperties?.().age ?? (b as any).metadata ?? 0;
        if (age >= 7) blocks.push(b);
      }
    }
  }
  if (!blocks.length) throw new Error('No mature crops found');
  let harvested = 0; const failed: Array<{x:number,y:number,z:number, error?: string}> = [];
  const maxMs = Number((params as any).maxMs ?? 120000);
  const start = Date.now();
  let lastProgressAt = start;
  for (const b of blocks) {
    if (Date.now() - start > maxMs) break;
    try {
      const p: any = (b as any).position || b;
      const movements = configureMovementsDefaults(new Movements(bot));
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1));
      const navStart = Date.now();
      while (Date.now() - navStart < 20000) { const d = bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)); if (d <= 2.5) break; await bot.waitForTicks(5); }
      // Prefer direct dig for reliability on crop blocks
      try { pushSuspendAutoEat(bot); await bot.dig(b as any); } finally { popSuspendAutoEat(bot); }
      await bot.waitForTicks(2);
      harvested++;
      lastProgressAt = Date.now();
      if (harvested >= want) break;
    } catch (e: any) {
      const q: any = (b as any).position || b;
      failed.push({ x: q.x, y: q.y, z: q.z, error: String(e?.message || e) });
    }
    if (Date.now() - lastProgressAt > 20000) break; // stall protection
  }
  const timedOut = Date.now() - start > maxMs;
  return { ok: harvested > 0, requested: want, harvested, remaining: Math.max(0, want - harvested), failed, timedOut };
  });
}

async function pickupItem(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = params.itemName ? String(params.itemName) : undefined;
  const ent = bot.nearestEntity((e: any) => e.type === 'object' && (!itemName || e.displayName === itemName));
  if (!ent) throw new Error('No dropped item found');
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalFollow(ent, 1));
  // wait up to 20 seconds to pick up and report partial
  const start = Date.now();
  const maxMs = Number((params as any).maxMs ?? 30000);
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
  let chest: any;
  try { pushSuspendAutoEat(bot); chest = await bot.openChest(pos as any); } finally { popSuspendAutoEat(bot); }
  await bot.waitForTicks(10);
  const items = chest.containerItems().map((i: any) => ({ name: i.name, count: i.count }));
  chest.close();
  return { ok: true, chestItems: items };
}

async function craftItems(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const itemName = String(params.itemName || params.name || 'stick');
  const count = Number(params.count ?? 1);
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const item = mcData.itemsByName[itemName];
  if (!item) throw new Error(`Unknown item ${itemName}`);
  // Determine if a table is needed by attempting recipes without a table first
  const recipesNoTable = bot.recipesFor(item.id, null, 1, null) || [];
  let tableBlock: any = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 }) || null;
  if (recipesNoTable.length === 0) {
    // Likely requires a crafting table
    if (!tableBlock) {
      const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (!tableItem) {
        return { ok: false, requested: count, crafted: 0, remaining: count, usedTable: false, timedOut: false, reason: 'missing_table', missingItems: [{ id: mcData.itemsByName['crafting_table']?.id ?? -1, name: 'crafting_table', count: 1 }], errors: ['crafting_table required but not found nearby or in inventory'] };
      }
      const ref = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!ref) return { ok: false, requested: count, crafted: 0, remaining: count, usedTable: false, timedOut: false, reason: 'missing_table', errors: ['No support block to place crafting_table'] };
      try { pushSuspendAutoEat(bot); await bot.equip(tableItem, 'hand'); } finally { popSuspendAutoEat(bot); }
      await bot.placeBlock(ref as any, new Vec3(0, 1, 0));
      await bot.waitForTicks(2);
      const pos = bot.entity.position.floored().offset(0, 0, 1);
      tableBlock = bot.blockAt(pos as any);
    }
  }

  // If using a table, path within 2 blocks so crafting UI opens reliably
  if (tableBlock) {
    const tp: any = (tableBlock as any).position || tableBlock;
    const movements = configureMovementsDefaults(new Movements(bot));
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
  if (!recipes || recipes.length === 0) {
    return { ok: false, requested: count, crafted: 0, remaining: count, usedTable: !!tableBlock, timedOut: false, reason: 'no_recipe', errors: ['No recipe for item in current context'] };
  }
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
        (async () => { pushSuspendAutoEat(bot); try { await bot.craft(recipe, amount, tableBlock || null); } finally { popSuspendAutoEat(bot); } })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('craft_timeout')), timeoutMs))
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  const errors: string[] = [];
  const deadline = Date.now() + Number((params as any).maxMs ?? 60000);
  let reason: string | undefined;

  const invCountByName = (n: string) => bot.inventory.items().filter(i => i.name === n).reduce((a, b) => a + b.count, 0);
  const countBefore = invCountByName(item.name);
  let crafted = 0;

  let lastProgressAt = Date.now();
  const idleMs = 12000;
  while (crafted < count && Date.now() < deadline) {
    try {
      await craftWithTimeout(1, 8000);
      await bot.waitForTicks(2);
      const now = invCountByName(item.name);
      const delta = Math.max(0, now - (countBefore + crafted));
      if (delta <= 0) {
        errors.push('no_output_from_craft');
        reason = reason || 'unknown';
        break;
      }
      crafted += delta;
      lastProgressAt = Date.now();
    } catch (e: any) {
      const msg = String(e?.message || e);
      errors.push(msg);
      if (msg.includes('timeout') || msg.includes('craft_timeout')) {
        reason = 'craft_timeout';
      } else {
        reason = reason || 'missing_resources';
      }
      break;
    }
    if (Date.now() - lastProgressAt > idleMs) { reason = reason || 'craft_stalled'; break; }
  }
  const timedOut = Date.now() >= deadline && crafted < count;
  // Always compute missing for visibility if we didn't craft everything
  const missingItems = crafted < count ? computeMissingFor(Math.max(1, count - crafted)) : [];
  return { ok: crafted > 0, requested: count, crafted, remaining: Math.max(0, count - crafted), usedTable: !!tableBlock, timedOut, reason, missingItems, errors };
  });
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

// List recipes across many items; optionally filter by requiresTable, craftability, and search term
async function listAllRecipes(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const requiresTableFilter = (params as any).requiresTable;
  const craftableOnly = Boolean((params as any).craftableOnly);
  const limit = Math.max(1, Math.min(500, Number((params as any).limit ?? 100)));
  const search = String((params as any).search ?? '').toLowerCase().trim();
  const mcDataMod = await import('minecraft-data');
  const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
  const itemsArr: any[] = Object.values(mcData.itemsByName);
  const tableBlock: any = bot.findBlock({ matching: (b: any) => b?.name === 'crafting_table', maxDistance: 16 }) || null;
  const invMap: Record<number, number> = {};
  for (const it of bot.inventory.items()) invMap[it.type] = (invMap[it.type] || 0) + it.count;
  const out: any[] = [];
  for (const it of itemsArr) {
    // Optional search filter by item name
    const itemName: string = String(it?.name || '').toLowerCase();
    const itemMatches = !search || itemName.includes(search);
    const recipesNo = bot.recipesFor(it.id, null, 1, null) || [];
    const recipesTab = tableBlock ? (bot.recipesFor(it.id, null, 1, tableBlock) || []) : [];
    const all = [...recipesNo, ...recipesTab];
    const seen = new Set<any>();
    for (const r of all) {
      if (seen.has(r)) continue; seen.add(r);
      const rec: any = r as any;
      const requiresTable = !!rec.requiresTable;
      if (typeof requiresTableFilter === 'boolean' && requiresTable !== requiresTableFilter) continue;
      // Build per-unit ingredient map
      const perUnitReq: Record<number, number> = {};
      if (Array.isArray(rec.ingredients)) {
        for (const ing of rec.ingredients) { if (!ing) continue; const id = Number(ing.id); const c = Number(ing.count ?? 1); perUnitReq[id] = (perUnitReq[id] || 0) + c; }
      }
      if (Array.isArray(rec.inShape)) {
        for (const row of rec.inShape) { if (!Array.isArray(row)) continue; for (const cell of row) { if (!cell) continue; const id = Number(cell.id); perUnitReq[id] = (perUnitReq[id] || 0) + 1; } }
      }
      // Ingredient search
      let ingMatches = false;
      if (search && !itemMatches) {
        for (const idStr of Object.keys(perUnitReq)) {
          const id = Number(idStr); const name = (mcData.items[id]?.name || '').toLowerCase();
          if (name.includes(search)) { ingMatches = true; break; }
        }
        if (!ingMatches) continue;
      }
      // Craftable estimate
      let max = 64;
      for (const idStr of Object.keys(perUnitReq)) { const id = Number(idStr); const need = perUnitReq[id]; const have = invMap[id] || 0; max = Math.min(max, Math.floor(have / need)); }
      const craftable = Math.max(0, max);
      if (craftableOnly && craftable <= 0) continue;
      const ingredients: Array<{ id: number; name: string; count: number }> = [];
      for (const idStr of Object.keys(perUnitReq)) {
        const id = Number(idStr); const name = mcData.items[id]?.name || String(id); const cnt = perUnitReq[id]; ingredients.push({ id, name, count: cnt });
      }
      out.push({ item: { id: it.id, name: it.name }, requiresTable, ingredients, craftable });
      if (out.length >= limit) return { ok: true, count: out.length, recipes: out };
    }
  }
  return { ok: true, count: out.length, recipes: out };
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

async function cookOrSmeltOnDevice(bot: Bot, device: 'furnace'|'smoker'|'blast_furnace', itemName: string, fuelName?: string, count: number = 1, totalMaxMs?: number) {
  const furnace: any = await openFurnaceLike(bot, device);
  try {
    try { await furnace.takeOutput(); } catch {}
    // Determine how many we can process based on inventory
    const invItems = bot.inventory.items().filter(i => i.name === itemName);
    const available = invItems.reduce((a, b) => a + b.count, 0);
    let toProcess = Math.max(1, Math.min(count, available));
    if (toProcess <= 0) throw new Error(`Missing input '${itemName}'`);
    // Ensure fuel present
    const findFuel = () => {
      const f = fuelName ? bot.inventory.items().find(i => i.name === fuelName)
        : bot.inventory.items().find(i => ['coal','charcoal','coal_block','lava_bucket','stick','oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks','bamboo_planks','crimson_planks','warped_planks'].includes(i.name));
      return f || null;
    };
    if (!furnace.fuelItem()) {
      const fuel = findFuel();
      if (fuel) {
        pushSuspendAutoEat(bot);
        try { await furnace.putFuel(fuel.type, null, Math.min(1, fuel.count)); } finally { popSuspendAutoEat(bot); }
      } else {
        // Start without fuel: report immediately
        return { ok: false, deviceUsed: device, outputsCollected: 0, requested: count, remaining: count, outOfFuel: true, reason: 'missing_fuel' };
      }
    }
    // Insert inputs in batches
    let inserted = 0;
    while (inserted < toProcess) {
      const nxt = bot.inventory.items().find(i => i.name === itemName && i.count > 0);
      if (!nxt) break;
      const batch = Math.min(nxt.count, toProcess - inserted);
      pushSuspendAutoEat(bot);
      try { await furnace.putInput(nxt.type, null, batch); } finally { popSuspendAutoEat(bot); }
      inserted += batch;
    }
    // Collect outputs until done or timeout
    const outputsTarget = inserted;
    let outputs = 0;
    const deadline = Date.now() + (totalMaxMs ?? Math.max(90000, 60000 * outputsTarget));
    let lastProgressAt = Date.now();
    let lastOutName: string | undefined;
    let outOfFuel = false;
    let refuelAttempts = 0;
    while (outputs < outputsTarget && Date.now() < deadline) {
      await bot.waitForTicks(10);
      try {
        const out = await furnace.takeOutput();
        if (out) {
          outputs += out.count ?? 1;
          lastOutName = out.name;
          lastProgressAt = Date.now();
        }
      } catch {}
      // Attempt refuel on stall
      if (Date.now() - lastProgressAt > 15000) {
        const hasFuelNow = !!furnace.fuelItem();
        if (!hasFuelNow) {
          const fuel = findFuel();
          if (fuel && refuelAttempts < 2) {
            try {
              pushSuspendAutoEat(bot);
              try { await furnace.putFuel(fuel.type, null, Math.min(1, fuel.count)); } finally { popSuspendAutoEat(bot); }
              refuelAttempts++;
              lastProgressAt = Date.now();
              continue;
            } catch {}
          }
          outOfFuel = true;
          break;
        }
        break; // stalled for another reason
      }
    }
    const timedOut = outputs < outputsTarget && Date.now() >= deadline;
    const stalled = outputs < outputsTarget && !timedOut && !outOfFuel;
    const reason = outOfFuel ? 'out_of_fuel' : timedOut ? 'timed_out' : (stalled ? 'stalled' : undefined);
    return { ok: outputs >= outputsTarget, deviceUsed: device, outputsCollected: outputs, requested: count, remaining: Math.max(0, count - outputs), timedOut, stalled, outOfFuel, reason, output: lastOutName };
  } finally {
    try { furnace.close(); } catch {}
  }
}

async function cookOnCampfire(bot: Bot, itemName: string) {
  const campfirePos = bot.findBlock({ matching: (b: any) => b?.name?.includes('campfire'), maxDistance: 16 });
  if (!campfirePos) throw new Error('No campfire nearby');
  const food = bot.inventory.items().find(i => i.name === itemName);
  if (!food) throw new Error(`Missing input '${itemName}'`);
  try { pushSuspendAutoEat(bot); await bot.equip(food, 'hand'); } finally { popSuspendAutoEat(bot); }
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  const cp: any = (campfirePos as any).position || campfirePos;
  bot.pathfinder.setGoal(new goals.GoalNear(cp.x, cp.y, cp.z, 1));
  await bot.waitForTicks(10);
  const block = bot.blockAt(campfirePos as any);
  if (!block) throw new Error('Campfire vanished');
  // Place items and wait
  try { pushSuspendAutoEat(bot); await bot.activateBlock(block as any); } finally { popSuspendAutoEat(bot); }
  const start = Date.now();
  const maxMs = 45000;
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
  return withTask(bot, async (_signal) => {
  const itemName = String(params.itemName || 'iron_ore');
  const preferDevice = params.preferDevice ? String(params.preferDevice) : undefined;
  const fuelName = params.fuelName ? String(params.fuelName) : undefined;
  const count = Number((params as any).count ?? 1);
  const isFoodItem = isLikelyFood(itemName);
  const isOreItem = isLikelyOre(itemName);
  const sequence: Array<'furnace'|'smoker'|'blast_furnace'|'campfire'> = [];
  if (preferDevice) {
    const p = preferDevice as any;
    if (p === 'campfire') sequence.push('campfire');
    else if (p === 'smoker') sequence.push('smoker');
    else if (p === 'blast_furnace') sequence.push('blast_furnace');
    else sequence.push('furnace');
    if (!sequence.includes('furnace')) sequence.push('furnace');
    if (isFoodItem && !sequence.includes('campfire')) sequence.push('campfire');
  } else if (isFoodItem) {
    sequence.push('smoker', 'furnace', 'campfire');
  } else if (isOreItem) {
    sequence.push('blast_furnace', 'furnace');
  } else {
    sequence.push('furnace');
  }
  const attempts: string[] = [];
  const errors: string[] = [];
  for (const dev of sequence) {
    attempts.push(dev);
    try {
      if (dev === 'campfire') {
        const r = await cookOnCampfire(bot, itemName);
        if (r?.ok) return { ...r, attemptedDevices: attempts };
        errors.push('campfire_failed');
        continue;
      }
      const r = await cookOrSmeltOnDevice(bot, dev, itemName, fuelName, count);
      if (r?.ok) return { ...r, attemptedDevices: attempts };
      errors.push(`${dev}_failed${r?.timedOut ? ':timedOut' : ''}`);
    } catch (e: any) {
      errors.push(`${dev}: ${String(e?.message || e)}`);
      continue;
    }
  }
  return { ok: false, error: 'no_device_available', attemptedDevices: attempts, errors };
  });
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

// Return to last death position and collect nearby drops (10-block radius)
async function returnToLastDeathLocation(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const last = (bot as any).__lastDeathPosition;
  if (!last || last.x == null) throw new Error('No last death position recorded');
  const target = new Vec3(Number(last.x), Number(last.y), Number(last.z));
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
  // wait up to 60s to arrive
  const begin = Date.now();
  while (Date.now() - begin < 60000) {
    const d = bot.entity.position.distanceTo(target);
    if (d <= 3) break;
    await bot.waitForTicks(5);
  }
  const arrived = bot.entity.position.distanceTo(target) <= 3;
  // Collect items within 10 blocks
  let pickedUp = 0;
  if (arrived) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const item = bot.nearestEntity((e: any) => e.type === 'object' && e.position.distanceTo(target) <= 10);
      if (!item) break;
      bot.pathfinder.setGoal(new goals.GoalFollow(item, 1));
      // brief wait to pick it up
      await bot.waitForTicks(20);
      pickedUp++;
    }
  }
  return { ok: arrived, arrived, pickedUp };
}

async function placeItemNearYou(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const itemName = String(params.itemName || params.name || 'cobblestone');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error('Item not in inventory');
  try { pushSuspendAutoEat(bot); await bot.equip(item, 'hand'); } finally { popSuspendAutoEat(bot); }

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
    const movements = configureMovementsDefaults(new Movements(bot));
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
  const requireWater = Boolean((params as any).requireWater ?? true);
  const hydrationRadius = 4; // Minecraft hydration: up to 4 blocks horizontally (diagonal included)
  const origin = bot.entity.position.floored();
  try { pushSuspendAutoEat(bot); await bot.equip(hoe, 'hand'); } finally { popSuspendAutoEat(bot); }
  let tilled = 0; const attempts: Array<{x:number,y:number,z:number, ok:boolean}> = [];
  let sawCandidate = false;
  let sawCandidateWithinWater = false;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const x = origin.x + dx, z = origin.z + dz;
      // search in small vertical band around feet
      for (let dy = -1; dy <= 2; dy++) {
        const pos = new Vec3(x, origin.y + dy, z);
        const b = bot.blockAt(pos);
        if (!b) continue;
        if (b.name !== 'dirt' && b.name !== 'grass_block') continue;
        const above = bot.blockAt(pos.offset(0, 1, 0));
        if (!above) continue;
        // If obstruction (grass/flower), clear it first
        if (above.boundingBox !== 'empty' && isPlantObstruction(above.name)) {
          try { await bot.dig(above as any); await bot.waitForTicks(2); } catch {}
        }
        const above2 = bot.blockAt(pos.offset(0, 1, 0));
        if (!above2 || above2.boundingBox !== 'empty') continue;
        sawCandidate = true;
        // Optional water proximity requirement (hydration)
        if (requireWater) {
          let waterFound = false;
          for (let rx = -hydrationRadius; rx <= hydrationRadius && !waterFound; rx++) {
            for (let rz = -hydrationRadius; rz <= hydrationRadius && !waterFound; rz++) {
              // Chebyshev distance <= 4
              if (Math.max(Math.abs(rx), Math.abs(rz)) > hydrationRadius) continue;
              // Only same Y or one above (vanilla hydration)
              for (let ry = 0; ry <= 1 && !waterFound; ry++) {
                const wp = pos.offset(rx, ry, rz);
                const w = bot.blockAt(wp);
                if (isWaterLike(w)) waterFound = true;
              }
            }
          }
          if (waterFound) sawCandidateWithinWater = true;
          if (!waterFound) continue;
        }
        // Move into range
        if (bot.entity.position.distanceTo(pos) > 4.2) {
          const movements = configureMovementsDefaults(new Movements(bot));
          bot.pathfinder.setMovements(movements);
          bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
          const navStart = Date.now();
          while (Date.now() - navStart < 15000) { if (bot.entity.position.distanceTo(pos) <= 4.2) break; await bot.waitForTicks(5); }
        }
        try { pushSuspendAutoEat(bot); await bot.activateBlock(b as any); } finally { popSuspendAutoEat(bot); }
        await bot.waitForTicks(3);
        const after = bot.blockAt(pos);
        const ok = !!after && after.name === 'farmland';
        attempts.push({ x: pos.x, y: pos.y, z: pos.z, ok });
        if (ok) tilled++;
        break; // stop vertical scan for this (x,z)
      }
    }
  }
  if (requireWater && tilled === 0 && sawCandidate && !sawCandidateWithinWater) {
    return { ok: false, tilled: 0, reason: 'no_water_nearby', hydrationRadius, attempted: attempts };
  }
  return { ok: tilled > 0, tilled, attempted: attempts };
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
  const setSpawn = Boolean((params as any).setSpawnIfDay ?? true);
  const bedPos = await pathfindToPredicate(bot, (b: any) => b?.name?.includes('bed'), 24, 1);
  // If daytime and setSpawn requested, use bed to set spawn point instead of sleeping
  try {
    const tod = (bot as any).time?.timeOfDay ?? (bot as any).time?.time;
    const isDay = typeof tod === 'number' ? (tod % 24000) < 12000 : false;
    if (setSpawn && isDay) {
      // Mineflayer: right-click bed in daytime sets spawn
      const bed = bot.blockAt((bedPos as any).position || (bedPos as any));
      if (bed) {
        await bot.activateBlock(bed as any);
        return { ok: true, action: 'set_spawn' };
      }
    }
  } catch {}
  await bot.sleep(bedPos as any);
  return { ok: true, action: 'slept' };
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
  return withTask(bot, async (_signal) => {
  const mode = String((params as any).mode ?? 'commands'); // 'commands' | 'survival'
  if (mode === 'commands') {
    const cmds = (params as any).commands as string[] | undefined;
    if (!Array.isArray(cmds) || cmds.length === 0) throw new Error('Provide commands array');
    for (const c of cmds) {
      const cmd = c.trim().startsWith('/') ? c.trim() : `/${c.trim()}`;
      bot.chat(cmd);
    }
    return { ok: true, mode };
  }
  // survival build: requires coordinates and itemName in inventory
  const x = Number((params as any).x);
  const y = Number((params as any).y);
  const z = Number((params as any).z);
  const itemName = String((params as any).itemName || '');
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('Provide x,y,z');
  if (!itemName) throw new Error('itemName required');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error('Item not in inventory');
  const support = bot.blockAt(new Vec3(x, y - 1, z));
  if (!support) throw new Error('No support block below target');
  try { pushSuspendAutoEat(bot); await bot.equip(item, 'hand'); } finally { popSuspendAutoEat(bot); }
  // Navigate close
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2));
  const begin = Date.now();
  while (Date.now() - begin < 20000) { if (bot.entity.position.distanceTo(new Vec3(x,y,z)) <= 4.5) break; await bot.waitForTicks(5); }
  try { pushSuspendAutoEat(bot); await bot.placeBlock(support as any, new Vec3(0, 1, 0)); } finally { popSuspendAutoEat(bot); }
  return { ok: true, mode };
  });
}

async function depositItemsToNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const itemName = String(params.itemName || params.name || '');
  const count = params.count != null ? Number(params.count) : null;
  if (!itemName) throw new Error('itemName required');
  const chestPos = await pathfindToPredicate(bot, (b: any) => b?.name?.includes('chest'), 24, 2);
  let chest: any;
  try { pushSuspendAutoEat(bot); chest = await bot.openChest(chestPos as any); } finally { popSuspendAutoEat(bot); }
  try {
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) throw new Error('Item not in inventory');
    try { pushSuspendAutoEat(bot); await chest.deposit(item.type, null, count ?? item.count); } finally { popSuspendAutoEat(bot); }
    const items = chest.containerItems().map((i: any) => ({ name: i.name, count: i.count }));
    return { ok: true, chestItems: items };
  } finally {
    chest.close();
  }
  });
}

async function withdrawItemsFromNearbyChest(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const itemName = String(params.itemName || params.name || '');
  const count = params.count != null ? Number(params.count) : null;
  if (!itemName) throw new Error('itemName required');
  const chestPos = await pathfindToPredicate(bot, (b: any) => b?.name?.includes('chest'), 24, 2);
  let chest: any;
  try { pushSuspendAutoEat(bot); chest = await bot.openChest(chestPos as any); } finally { popSuspendAutoEat(bot); }
  try {
    const mcDataMod = await import('minecraft-data');
    const mcData = (mcDataMod as any).default ? (mcDataMod as any).default(bot.version) : (mcDataMod as any)(bot.version);
    const item = mcData.itemsByName[itemName];
    if (!item) throw new Error(`Unknown item ${itemName}`);
    try { pushSuspendAutoEat(bot); await chest.withdraw(item.id, null, count ?? 1); } finally { popSuspendAutoEat(bot); }
    const items = chest.containerItems().map((i: any) => ({ name: i.name, count: i.count }));
    return { ok: true, chestItems: items };
  } finally {
    chest.close();
  }
  });
}

async function digBlock(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  const block = bot.blockAt(new Vec3(x, y, z));
  if (!block) throw new Error('Block not found');
  try { pushSuspendAutoEat(bot); await bot.dig(block as any); } finally { popSuspendAutoEat(bot); }
  return { ok: true };
  });
}

async function placeBlockAt(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const x = Number(params.x), y = Number(params.y), z = Number(params.z);
  const itemName = String(params.itemName || params.name || '');
  if (!itemName) throw new Error('itemName required');
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error('Item not in inventory');
  const below = bot.blockAt(new Vec3(x, y - 1, z));
  if (!below) throw new Error('No support block below target');
  try { pushSuspendAutoEat(bot); await bot.equip(item, 'hand'); } finally { popSuspendAutoEat(bot); }
  // Move into range if needed
  const targetVec = new Vec3(x, y, z);
  if (bot.entity.position.distanceTo(targetVec) > 4.5) {
    const movements = configureMovementsDefaults(new Movements(bot));
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2));
    const start = Date.now();
    while (Date.now() - start < 20000) { if (bot.entity.position.distanceTo(targetVec) <= 4.5) break; await bot.waitForTicks(5); }
  }
  try { pushSuspendAutoEat(bot); await bot.placeBlock(below as any, new Vec3(0, 1, 0)); } finally { popSuspendAutoEat(bot); }
  return { ok: true };
  });
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

async function goToSurface(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  // Move up until we find sky exposure or y increases to a safe threshold
  const start = bot.entity.position.floored();
  let target: Vec3 | null = null;
  for (let dy = 0; dy < 64; dy++) {
    const y = start.y + dy;
    const head = new Vec3(start.x, y + 1, start.z);
    let clearAbove = true;
    for (let ay = 0; ay < 20; ay++) {
      const b = bot.blockAt(head.offset(0, ay, 0));
      if (b && b.boundingBox !== 'empty') { clearAbove = false; break; }
    }
    if (clearAbove) { target = new Vec3(start.x, y, start.z); break; }
  }
  if (!target) throw new Error('No clear surface found above');
  const movements = configureMovementsDefaults(new Movements(bot));
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
  // Wait until at surface: close to target and clear to sky at current pos
  const begin = Date.now();
  const maxMs = Number((params as any).maxMs ?? 90000);
  let arrived = false;
  while (Date.now() - begin < maxMs) {
    const d = bot.entity.position.distanceTo(target);
    const near = d <= 3;
    const clear = isClearToSkyAt(bot, bot.entity.position.floored());
    if (near && clear) { arrived = true; break; }
    await bot.waitForTicks(5);
  }
  return { ok: arrived, arrived };
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
  const movements = configureMovementsDefaults(new Movements(bot));
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
  const radius = Math.max(1, Math.min(12, Number((params as any).radius ?? 6)));
  const origin = bot.entity.position.floored();
  const blockCounts: Record<string, number> = {};
  const sampleCoords: Record<string, Array<{x:number,y:number,z:number}>> = {};
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -Math.min(4, radius); dy <= Math.min(4, radius); dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const b = bot.blockAt(new Vec3(origin.x + dx, origin.y + dy, origin.z + dz));
        if (!b) continue;
        if (b.boundingBox === 'empty') continue;
        blockCounts[b.name] = (blockCounts[b.name] || 0) + 1;
        const key = b.name;
        if (!sampleCoords[key]) sampleCoords[key] = [];
        if (sampleCoords[key].length < 5) {
          const p: any = (b as any).position || new Vec3(origin.x + dx, origin.y + dy, origin.z + dz);
          sampleCoords[key].push({ x: p.x, y: p.y, z: p.z });
        }
      }
    }
  }
  const entities = Object.values(bot.entities).filter((e: any) => e.position && e.position.distanceTo(bot.entity.position) <= radius + 2)
    .map((e: any) => ({ id: e.id, name: e.name || e.username || e.displayName, type: e.type, position: { x: e.position.x, y: e.position.y, z: e.position.z } }));
  // Items on ground (entity.type === 'object')
  const mcData = (bot as any).__mcdata;
  const dropped = Object.values(bot.entities)
    .filter((e: any) => e.type === 'object' && e.position && e.position.distanceTo(bot.entity.position) <= radius + 2)
    .map((e: any) => {
      const info = deriveDroppedItemInfo(e, mcData);
      return { id: e.id, position: { x: e.position.x, y: e.position.y, z: e.position.z }, item: info };
    });
  return { ok: true, blocks: blockCounts, samples: sampleCoords, entities, droppedItems: dropped };
}

// Plant seeds within radius
async function plantSeedsWithinRadius(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  return withTask(bot, async (_signal) => {
  const seedName = String((params as any).seedName ?? 'wheat_seeds');
  const radius = Number((params as any).radius ?? 3);
  const seed = bot.inventory.items().find(i => i.name === seedName);
  if (!seed) throw new Error('Seeds not in inventory');
  try { pushSuspendAutoEat(bot); await bot.equip(seed, 'hand'); } finally { popSuspendAutoEat(bot); }
  const origin = bot.entity.position.floored();
  let planted = 0; const failed: Array<{x:number,y:number,z:number, reason?: string}> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const x = origin.x + dx, z = origin.z + dz;
      // scan small vertical band
      let pos: Vec3 | null = null;
      let farmland: any = null;
      let above: any = null;
      for (let dy = -1; dy <= 2; dy++) {
        const p = new Vec3(x, origin.y + dy, z);
        const bl = bot.blockAt(p);
        const ab = bot.blockAt(p.offset(0,1,0));
        if (!bl || !ab) continue;
        if (bl.name === 'farmland' && ab.boundingBox === 'empty') {
          pos = p; farmland = bl; above = ab; break;
        }
      }
      if (!pos) continue;
      try {
        // Ensure range
        if (bot.entity.position.distanceTo(pos) > 4.5) {
          const movements = configureMovementsDefaults(new Movements(bot));
          bot.pathfinder.setMovements(movements);
          bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
          const navStart = Date.now();
          while (Date.now() - navStart < 15000) { if (bot.entity.position.distanceTo(pos) <= 4.5) break; await bot.waitForTicks(5); }
        }
        // Use item on farmland to plant (some servers require right-click with seed)
        try { pushSuspendAutoEat(bot); await bot.activateBlock(farmland as any); } finally { popSuspendAutoEat(bot); }
        planted++;
        await bot.waitForTicks(3);
        // Verify a crop appeared
        const crop = bot.blockAt(pos.offset(0,1,0));
        if (!crop || (crop.name !== 'wheat' && crop.name !== 'carrots' && crop.name !== 'potatoes' && crop.name !== 'beetroots')) {
          failed.push({ x: pos.x, y: pos.y, z: pos.z, reason: 'no_crop_detected' });
        }
      } catch (e: any) {
        failed.push({ x: pos.x, y: pos.y, z: pos.z, reason: String(e?.message || e) });
      }
    }
  }
  return { ok: planted > 0, planted, failed };
  });
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
  // Equip best weapon: bow at range if possible, else best melee
  try {
    const rangedMin = 8; // fixed threshold for ranged attacks
    const dist = bot.entity.position.distanceTo(entity.position);
    if (!(await equipBowIfAvailable(bot)) || dist <= rangedMin) {
      await equipBestMeleeWeapon(bot);
    } else if (dist > rangedMin) {
      const aim = entity.position.offset(0, (entity as any).height ? (entity as any).height * 0.8 : 1.5, 0);
      await bot.lookAt(aim, true);
      // @ts-ignore
      bot.activateItem();
      await bot.waitForTicks(15);
      // @ts-ignore
      bot.deactivateItem();
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
  try { pushSuspendAutoEat(bot); await bot.equip(item, destination as any); } finally { popSuspendAutoEat(bot); }
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
  // Deprecated in favor of scanArea; keep for backward compatibility but no-op fast
  const bot = getBotOrThrow(String(params.username || ""));
  return { ok: true, deprecated: true };
}

async function eatFood(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  // @ts-ignore
  if (!bot.autoEat) throw new Error("auto-eat not available");
  // @ts-ignore
  await bot.autoEat.eat();
  return { ok: true };
}

// Gather wheat seeds by breaking nearby grass/tall_grass until count reached
async function gatherSeeds(params: Record<string, unknown>) {
  const bot = getBotOrThrow(String(params.username || ""));
  const targetSeeds = Math.max(1, Number((params as any).count ?? 8));
  const radius = Math.max(2, Math.min(32, Number((params as any).radius ?? 8)));
  const maxMs = Number((params as any).maxMs ?? 120000);
  const start = Date.now();
  let lastProgressAt = start;
  const stallMs = 20000;

  const countSeeds = () => bot.inventory.items().filter(i => i.name === 'wheat_seeds').reduce((a,b)=>a+b.count,0);
  const seedsStart = countSeeds();

  // Scan neighborhood for grass/tall_grass (both halves) and ferns small plants
  const origin = bot.entity.position.floored();
  const targets: any[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const p = new Vec3(origin.x + dx, origin.y + dy, origin.z + dz);
        const b = bot.blockAt(p);
        if (!b) continue;
        if (b.name === 'grass' || b.name === 'tall_grass' || b.name === 'fern' || b.name === 'large_fern') targets.push(b);
      }
    }
  }
  if (!targets.length) throw new Error('No grass nearby');

  let broken = 0; const errors: Array<{x:number,y:number,z:number,error:string}> = [];
  for (const b of targets) {
    try {
      // Move close
      const p: any = (b as any).position || b;
      const movements = configureMovementsDefaults(new Movements(bot));
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1));
      const navStart = Date.now();
      while (Date.now() - navStart < 15000) { const d = bot.entity.position.distanceTo(new Vec3(p.x, p.y, p.z)); if (d <= 2.5) break; await bot.waitForTicks(5); }
      try { pushSuspendAutoEat(bot); await bot.dig(b as any); } finally { popSuspendAutoEat(bot); }
      broken++;
      await bot.waitForTicks(2);
      const seedsNow = countSeeds();
      if (seedsNow > seedsStart) {
        lastProgressAt = Date.now();
      }
      if (seedsNow - seedsStart >= targetSeeds) break;
    } catch (e: any) {
      const q: any = (b as any).position || b;
      errors.push({ x: q.x, y: q.y, z: q.z, error: String(e?.message || e) });
    }
    if (Date.now() - lastProgressAt > stallMs || Date.now() - start > maxMs) break;
  }
  const seedsEnd = countSeeds();
  const gained = Math.max(0, seedsEnd - seedsStart);
  const timedOut = Date.now() - start > maxMs;
  const stalled = Date.now() - lastProgressAt > stallMs && gained < targetSeeds;
  return { ok: gained > 0, requested: targetSeeds, seeds: gained, remaining: Math.max(0, targetSeeds - gained), broken, timedOut, stalled, errors };
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
      case "listAllRecipes": action = await listAllRecipes(args); break;
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
      case "goToSurface": action = await goToSurface(args); break;
      case "depositItemsToNearbyChest": action = await depositItemsToNearbyChest(args); break;
      case "withdrawItemsFromNearbyChest": action = await withdrawItemsFromNearbyChest(args); break;
      case "digBlock": action = await digBlock(args); break;
      case "placeBlockAt": action = await placeBlockAt(args); break;
      case "listInventory": action = await listInventory(args); break;
      case "detectGamemode": action = await detectGamemode(args); break;
      case "findBlock": action = await findBlock(args); break;
      case "findEntity": action = await findEntity(args); break;
      case "scanArea": action = await scanArea(args); break;
      case "returnToLastDeathLocation": action = await returnToLastDeathLocation(args); break;
      case "plantSeedsWithinRadius": action = await plantSeedsWithinRadius(args); break;
      case "gatherSeeds": action = await gatherSeeds(args); break;
      case "stopAttack": action = await stopAttack(args); break;
      case "stopAllTasks": action = await stopAllTasks(args); break;
      // selfDefense removed

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
    ,{ name: "hunt", description: "Hunt animals or mobs until count reached (kills)", inputSchema: { type: "object", properties: { username: { type: "string" }, targetName: { type: "string" }, targetType: { type: "string" }, count: { type: "number" }, maxMs: { type: "number" } } } }
    ,{ name: "mineResource", description: "Mine specific blocks or resources", inputSchema: { type: "object", properties: { username: { type: "string" }, blockName: { type: "string" }, count: { type: "number" } }, required: ["blockName"] } }
    ,{ name: "harvestMatureCrops", description: "Harvest mature crops from farmland with progress timeouts", inputSchema: { type: "object", properties: { username: { type: "string" }, count: { type: "number" }, maxMs: { type: "number" } } } }
    ,{ name: "pickupItem", description: "Pick up items from the ground", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } } } }
    ,{ name: "craftItems", description: "Craft items using a crafting table", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } }
    ,{ name: "listRecipes", description: "List recipes for an item and how many are craftable with current inventory", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "listAllRecipes", description: "List many recipes across items; filter by search, requiresTable, craftableOnly, limit", inputSchema: { type: "object", properties: { username: { type: "string" }, search: { type: "string" }, requiresTable: { type: "boolean" }, craftableOnly: { type: "boolean" }, limit: { type: "number" } } } }
    ,{ name: "cookItem", description: "Cook items (furnace/smoker/campfire; campfire ignores count)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" }, count: { type: "number" }, preferDevice: { type: "string", enum: ["furnace","smoker","blast_furnace","campfire"] } }, required: ["itemName"] } }
    ,{ name: "smeltItem", description: "Smelt items (blast_furnace/furnace with fallback)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" }, count: { type: "number" }, preferDevice: { type: "string", enum: ["furnace","smoker","blast_furnace","campfire"] } }, required: ["itemName"] } }
    ,{ name: "cookWithSmoker", description: "Cook items in a smoker (optimized for food)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "smeltWithBlastFurnace", description: "Smelt items in a blast furnace (optimized for ores)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, fuelName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "cookWithCampfire", description: "Cook items on a campfire (no fuel, slower)", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "retrieveItemsFromNearbyFurnace", description: "Get smelted items from furnace", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "placeItemNearYou", description: "Place blocks near the bot", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" } }, required: ["itemName"] } }
    ,{ name: "prepareLandForFarming", description: "Prepare land for farming (till near water; clears plants)", inputSchema: { type: "object", properties: { username: { type: "string" }, radius: { type: "number" }, requireWater: { type: "boolean" }, waterRadius: { type: "number" } } } }
    ,{ name: "useItemOnBlockOrEntity", description: "Use items on blocks or entities", inputSchema: { type: "object", properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, userName: { type: "string" } } } }
    ,{ name: "rest", description: "Rest to regain health (wait)", inputSchema: { type: "object", properties: { ms: { type: "number" } } } }
    ,{ name: "sleepInNearbyBed", description: "Find and sleep in a bed; if daytime, set spawn on the bed", inputSchema: { type: "object", properties: { username: { type: "string" }, setSpawnIfDay: { type: "boolean" } } } }
    ,{ name: "openNearbyChest", description: "Open a nearby chest", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "dance", description: "Make the bot dance", inputSchema: { type: "object", properties: { username: { type: "string" }, durationMs: { type: "number" } } } }
    ,{ name: "buildSomething", description: "Build structures using commands (creative) or survival placement", inputSchema: { type: "object", properties: { username: { type: "string" }, mode: { type: "string", enum: ["commands","survival"] }, commands: { type: "array", items: { type: "string" } }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, itemName: { type: "string" } } } }
    ,{ name: "depositItemsToNearbyChest", description: "Deposit items to nearby chest", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } }
    ,{ name: "withdrawItemsFromNearbyChest", description: "Withdraw items from nearby chest", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } }
    ,{ name: "digBlock", description: "Dig a block at coordinates", inputSchema: { type: "object", properties: { username: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } }
    ,{ name: "placeBlockAt", description: "Place a block at coordinates", inputSchema: { type: "object", properties: { username: { type: "string" }, itemName: { type: "string" }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["itemName","x","y","z"] } }
    ,{ name: "listInventory", description: "List inventory items", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "detectGamemode", description: "Detect current game mode", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "goToSurface", description: "Move to the nearest surface above the bot", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "findBlock", description: "Find nearest block of a type", inputSchema: { type: "object", properties: { username: { type: "string" }, blockName: { type: "string" } }, required: ["blockName"] } }
    ,{ name: "findEntity", description: "Find nearest entity of a type", inputSchema: { type: "object", properties: { username: { type: "string" }, targetName: { type: "string" }, type: { type: "string" } } } }
    ,{ name: "scanArea", description: "Scan blocks/entities within radius with counts and sample coordinates; includes dropped items", inputSchema: { type: "object", properties: { username: { type: "string" }, radius: { type: "number" } } } }
    ,{ name: "returnToLastDeathLocation", description: "Return to recorded death position and collect drops nearby", inputSchema: { type: "object", properties: { username: { type: "string" } } } }
    ,{ name: "plantSeedsWithinRadius", description: "Plant seeds on nearby farmland within radius", inputSchema: { type: "object", properties: { username: { type: "string" }, seedName: { type: "string" }, radius: { type: "number" } } } }
    ,{ name: "gatherSeeds", description: "Break grass to collect wheat_seeds until count reached", inputSchema: { type: "object", properties: { username: { type: "string" }, count: { type: "number" }, radius: { type: "number" }, maxMs: { type: "number" } } } }
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



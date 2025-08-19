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



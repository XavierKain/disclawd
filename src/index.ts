import { Client, GatewayIntentBits, TextChannel, Message, ChannelType } from "discord.js";
import {
  DISCORD_TOKEN, ALLOWED_USER_ID, GUILD_ID,
  MAX_CONCURRENT_SESSIONS, getChannelConfig,
} from "./config.js";
import { upsertSession, getSession } from "./database.js";
import {
  sendMessage, isSessionActive, getActiveSessionCount, shutdownAll,
  type SessionCallbacks,
} from "./claude-session.js";
import { StreamingResponse, formatToolActivity } from "./discord-formatter.js";
import { getChannelMemories, needsCompaction, compactSession, POST_COMPACT_GUARDRAIL } from "./memory.js";
import {
  trackActivity, buildActivityDigest, parseRouteCommand,
} from "./general-orchestrator.js";
import type { TodoItem } from "./types.js";

// Message queue per channel (when session is busy)
const messageQueues = new Map<string, { message: string; discordMsg: Message }[]>();

// General channel ID
const GENERAL_CHANNEL_ID = "1489964893712158811";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => {
  console.log(`🤖 Jarvis connecté en tant que ${client.user?.tag}`);
  console.log(`📡 Guild: ${GUILD_ID}`);
  console.log(`👤 Utilisateur autorisé: ${ALLOWED_USER_ID}`);
  console.log(`🔧 Max sessions concurrentes: ${MAX_CONCURRENT_SESSIONS}`);
});

client.on("messageCreate", async (message: Message) => {
  // Ignore bots and non-guild messages
  if (message.author.bot) return;
  if (!message.guild || message.guild.id !== GUILD_ID) return;

  // Only respond to allowed user
  if (message.author.id !== ALLOWED_USER_ID) return;

  // Only handle text channels
  if (message.channel.type !== ChannelType.GuildText) return;

  const channel = message.channel as TextChannel;
  const channelName = channel.name;
  const channelId = channel.id;
  const content = message.content.trim();

  // Ignore empty messages
  if (!content) return;

  // Handle special commands
  if (content.startsWith("!")) {
    await handleCommand(content.slice(1).trim(), channel, message);
    return;
  }

  // Check concurrent session limit
  if (!isSessionActive(channelId) && getActiveSessionCount() >= MAX_CONCURRENT_SESSIONS) {
    await channel.send(`⚠️ ${MAX_CONCURRENT_SESSIONS} sessions actives. Attends qu'une se termine ou utilise \`!stop #channel\`.`);
    return;
  }

  // If session is active in this channel, queue the message
  if (isSessionActive(channelId)) {
    const queue = messageQueues.get(channelId) || [];
    if (queue.length >= 5) {
      await channel.send("⚠️ File d'attente pleine (5 messages). Attends que la session termine.");
      return;
    }
    queue.push({ message: content, discordMsg: message });
    messageQueues.set(channelId, queue);
    await message.react("⏳");
    return;
  }

  await processMessage(channelId, channelName, content, channel, message);
});

async function processMessage(
  channelId: string,
  channelName: string,
  content: string,
  channel: TextChannel,
  discordMessage: Message,
) {
  const config = getChannelConfig(channelId, channelName);

  // Initialize session in DB
  upsertSession(channelId, channelName, getSession(channelId)?.session_id || null, config.projectDir);

  // Check if compaction is needed
  if (needsCompaction(channelId)) {
    await channel.send("🧠 Compaction de la mémoire en cours...");
    try {
      const summary = await compactSession(channelId, channelName, config.projectDir, config.systemPrompt);
      trackActivity(channelId, channelName, "compaction", `Mémoire compactée: ${summary.slice(0, 100)}...`);
      // Reset session so next message starts fresh with memory
      upsertSession(channelId, channelName, null, config.projectDir);
    } catch (err) {
      await channel.send(`⚠️ Erreur de compaction: ${err}`);
    }
  }

  // Get channel memories
  const memories = getChannelMemories(channelId);

  // Build system prompt - add activity digest for #général
  let systemPrompt = config.systemPrompt;
  if (channelId === GENERAL_CHANNEL_ID) {
    systemPrompt += "\n\n" + buildActivityDigest();
  }

  // Check for route commands from #général
  if (channelId === GENERAL_CHANNEL_ID) {
    const routeCmd = parseRouteCommand(content);
    if (routeCmd) {
      await routeToChannel(routeCmd.targetChannel, routeCmd.command, channel);
      return;
    }
  }

  // Show typing
  await discordMessage.react("⚡");

  // Create streaming response handler
  const streamer = new StreamingResponse(channel);
  let currentTodos: TodoItem[] = [];

  const callbacks: SessionCallbacks = {
    onText: (text) => {
      if (config.streaming) {
        streamer.appendText(text);
      }
    },
    onTodoUpdate: (todos) => {
      currentTodos = todos;
      if (config.streaming) {
        streamer.updateStatus(todos, streamer["currentTool"] || undefined);
      }
    },
    onToolUse: (toolName, input) => {
      const activity = formatToolActivity(toolName, input);
      if (activity) {
        streamer.setCurrentTool(activity);
        if (config.streaming) {
          streamer.updateStatus(currentTodos, activity);
        }
      }
    },
    onResult: async (result) => {
      await streamer.flush();

      if (!config.streaming) {
        // For non-streaming channels, send the accumulated text now
        // (it was buffered but not sent during streaming)
      }

      await streamer.finish(result);

      // Log activity for #général
      trackActivity(channelId, channelName, "completed",
        `Session terminée (${result?.num_turns || 0} tours, ${Math.round((result?.duration_ms || 0) / 1000)}s)`
      );

      // Remove reaction
      try { await discordMessage.reactions.cache.get("⚡")?.users.remove(client.user!.id); } catch {}

      // Process queued messages
      processQueue(channelId, channelName, channel);
    },
    onError: async (error) => {
      await streamer.sendError(error);
      trackActivity(channelId, channelName, "error", error.slice(0, 200));
    },
    onSessionId: (sessionId) => {
      upsertSession(channelId, channelName, sessionId, config.projectDir);
    },
    onHeartbeat: () => {
      streamer.heartbeat();
    },
  };

  // Log activity
  trackActivity(channelId, channelName, "message", content.slice(0, 200));

  try {
    await sendMessage(channelId, channelName, content, config.projectDir, systemPrompt, callbacks, memories);
  } catch (err) {
    await channel.send(`**Erreur:** ${err}`);
    trackActivity(channelId, channelName, "error", String(err).slice(0, 200));
  }
}

async function processQueue(channelId: string, channelName: string, channel: TextChannel) {
  const queue = messageQueues.get(channelId);
  if (!queue || queue.length === 0) return;

  const next = queue.shift()!;
  if (queue.length === 0) messageQueues.delete(channelId);

  // Remove ⏳ reaction
  try { await next.discordMsg.reactions.cache.get("⏳")?.users.remove(client.user!.id); } catch {}

  await processMessage(channelId, channelName, next.message, channel, next.discordMsg);
}

async function routeToChannel(targetChannelName: string, command: string, sourceChannel: TextChannel) {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const targetChannel = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildText && ch.name === targetChannelName
  ) as TextChannel | undefined;

  if (!targetChannel) {
    await sourceChannel.send(`❌ Channel #${targetChannelName} introuvable.`);
    return;
  }

  await sourceChannel.send(`📤 Commande routée vers #${targetChannelName}: ${command.slice(0, 100)}`);

  // Send the command to the target channel
  await targetChannel.send(`📥 **Commande de #général:** ${command}`);

  // Trigger processing in the target channel (simulate a message)
  const config = getChannelConfig(targetChannel.id, targetChannelName);
  upsertSession(targetChannel.id, targetChannelName, getSession(targetChannel.id)?.session_id || null, config.projectDir);

  const memories = getChannelMemories(targetChannel.id);
  const streamer = new StreamingResponse(targetChannel);
  let currentTodos: TodoItem[] = [];

  const callbacks: SessionCallbacks = {
    onText: (text) => { if (config.streaming) streamer.appendText(text); },
    onTodoUpdate: (todos) => { currentTodos = todos; if (config.streaming) streamer.updateStatus(todos); },
    onToolUse: (toolName, input) => {
      const activity = formatToolActivity(toolName, input);
      if (activity && config.streaming) streamer.updateStatus(currentTodos, activity);
    },
    onResult: async (result) => {
      await streamer.flush();
      await streamer.finish(result);
      trackActivity(targetChannel.id, targetChannelName, "routed-completed",
        `Commande de #général terminée: ${command.slice(0, 100)}`
      );
      // Notify source channel
      await sourceChannel.send(`✅ #${targetChannelName} a terminé la commande.`);
    },
    onError: (err) => streamer.sendError(err),
    onSessionId: (sid) => upsertSession(targetChannel.id, targetChannelName, sid, config.projectDir),
    onHeartbeat: () => streamer.heartbeat(),
  };

  trackActivity(targetChannel.id, targetChannelName, "routed", `Commande de #général: ${command.slice(0, 100)}`);

  try {
    await sendMessage(targetChannel.id, targetChannelName, command, config.projectDir, config.systemPrompt, callbacks, memories);
  } catch (err) {
    await sourceChannel.send(`❌ Erreur dans #${targetChannelName}: ${err}`);
  }
}

async function handleCommand(cmd: string, channel: TextChannel, message: Message) {
  const parts = cmd.split(/\s+/);
  const action = parts[0]?.toLowerCase();

  switch (action) {
    case "status": {
      const sessions = getActiveSessionCount();
      const queues = Array.from(messageQueues.entries())
        .filter(([_, q]) => q.length > 0)
        .map(([id, q]) => `  #${client.channels.cache.get(id)?.toString() || id}: ${q.length} en attente`);

      let status = `**Sessions actives:** ${sessions}/${MAX_CONCURRENT_SESSIONS}`;
      if (queues.length > 0) status += "\n**Files d'attente:**\n" + queues.join("\n");
      await channel.send(status);
      break;
    }

    case "stop": {
      const target = parts[1]?.replace("#", "");
      if (target) {
        const guild = client.guilds.cache.get(GUILD_ID);
        const ch = guild?.channels.cache.find(c => c.name === target);
        if (ch) {
          const { stopSession } = await import("./claude-session.js");
          await stopSession(ch.id);
          await channel.send(`⏹️ Session #${target} arrêtée.`);
        } else {
          await channel.send(`❌ Channel #${target} introuvable.`);
        }
      } else {
        // Stop current channel
        const { stopSession } = await import("./claude-session.js");
        await stopSession(channel.id);
        await channel.send("⏹️ Session arrêtée.");
      }
      break;
    }

    case "reset": {
      upsertSession(channel.id, channel.name, null, getChannelConfig(channel.id, channel.name).projectDir);
      await channel.send("🔄 Session réinitialisée. Prochaine conversation = nouveau contexte.");
      break;
    }

    case "memory": {
      const memories = getChannelMemories(channel.id);
      if (memories.length === 0) {
        await channel.send("Aucune mémoire pour ce channel.");
      } else {
        const text = memories.map((m, i) => `**${i + 1}.** ${m.slice(0, 200)}${m.length > 200 ? "..." : ""}`).join("\n\n");
        await channel.send(`**Mémoire de #${channel.name}:**\n${text}`);
      }
      break;
    }

    case "help": {
      await channel.send(`**Commandes Jarvis:**
\`!status\` — Sessions actives et files d'attente
\`!stop [#channel]\` — Arrêter une session
\`!reset\` — Réinitialiser le contexte de ce channel
\`!memory\` — Voir la mémoire de ce channel
\`!help\` — Cette aide

**Depuis #général:**
\`@#channel-name message\` — Envoyer une commande à un autre channel
\`dis à #channel-name de ...\` — Idem en français
\`dans #channel-name, ...\` — Idem`);
      break;
    }

    default:
      await channel.send(`Commande inconnue: \`${action}\`. Tape \`!help\` pour la liste.`);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Arrêt en cours...");
  await shutdownAll();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM reçu, arrêt...");
  await shutdownAll();
  client.destroy();
  process.exit(0);
});

// Start
client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Échec de connexion Discord:", err);
  process.exit(1);
});

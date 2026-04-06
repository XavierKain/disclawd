import { TextChannel } from "discord.js";
import { getRecentActivity, getActivitySince, logActivity } from "./database.js";

// Track last digest time
let lastDigestTime = Math.floor(Date.now() / 1000);

/**
 * Log an activity event from any channel (for #général's awareness)
 */
export function trackActivity(channelId: string, channelName: string, eventType: string, summary: string) {
  logActivity(channelId, channelName, eventType, summary);
}

/**
 * Build a digest of recent activity across all channels.
 * Injected into #général's system prompt so it has global awareness.
 */
export function buildActivityDigest(): string {
  const activities = getRecentActivity();
  if (activities.length === 0) return "Aucune activité récente.";

  const lines = activities.map((a: any) => {
    const time = new Date(a.created_at * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return `[${time}] #${a.channel_name} — ${a.event_type}: ${a.summary}`;
  });

  return `## Activité récente des autres channels\n${lines.join("\n")}`;
}

/**
 * Get new activity since last check
 */
export function getNewActivity(): string | null {
  const activities = getActivitySince(lastDigestTime);
  lastDigestTime = Math.floor(Date.now() / 1000);

  if (activities.length === 0) return null;

  const lines = activities.map((a: any) => {
    const time = new Date(a.created_at * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return `[${time}] #${a.channel_name} — ${a.event_type}: ${a.summary}`;
  });

  return lines.join("\n");
}

/**
 * Parse a command from #général targeting another channel.
 * Format: "@#channel-name message" or "dis à #channel-name de faire X"
 */
export function parseRouteCommand(message: string): { targetChannel: string; command: string } | null {
  // Pattern: @#channel-name rest of message
  const atMatch = message.match(/^@#([\w-]+)\s+(.+)$/s);
  if (atMatch) {
    return { targetChannel: atMatch[1], command: atMatch[2] };
  }

  // Pattern: "dis à #channel-name de ..."
  const disMatch = message.match(/^dis\s+[àa]\s+#([\w-]+)\s+de\s+(.+)$/si);
  if (disMatch) {
    return { targetChannel: disMatch[1], command: disMatch[2] };
  }

  // Pattern: "dans #channel-name, ..."
  const dansMatch = message.match(/^dans\s+#([\w-]+),?\s+(.+)$/si);
  if (dansMatch) {
    return { targetChannel: dansMatch[1], command: dansMatch[2] };
  }

  return null;
}

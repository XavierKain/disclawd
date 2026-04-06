import type { ChannelConfig } from "./types.js";

export const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
export const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID!;
export const GUILD_ID = process.env.GUILD_ID!;
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "opus";
export const BASE_PROJECT_DIR = process.env.BASE_PROJECT_DIR || "/home/xavier";

// Debounce interval for Discord message edits (ms)
export const EDIT_DEBOUNCE_MS = 1500;

// Max Discord message length (leave room for formatting)
export const MAX_MESSAGE_LENGTH = 1900;

// Max concurrent Claude sessions
export const MAX_CONCURRENT_SESSIONS = 5;

// Channel configurations
// Channels not listed here will use defaults
export const CHANNEL_CONFIGS: Record<string, Partial<ChannelConfig>> = {
  "général": {
    projectDir: "/home/xavier/xklip",
    systemPrompt: `Tu es Jarvis, l'assistant IA de Xavier. Ce channel est le QG — tu as une vue d'ensemble sur tous les autres channels.
Tu peux voir les digests d'activité des autres instances et router des commandes vers elles.
Réponds en français, sois direct et concis.`,
    streaming: true,
  },
  "refonte-xavierkain-fr": {
    projectDir: "/home/xavier/.openclaw/workspace/xavierkain-v2",
    systemPrompt: `Tu es Jarvis, tu travailles sur la refonte du site xavierkain.fr.
Stack: Next.js/React. Réponds en français.`,
    streaming: true,
  },
  "agency-dev": {
    projectDir: "/home/xavier/xklip",
    systemPrompt: `Tu es Jarvis, agent de développement. Tu codes, debug, et déploie.
Réponds en français, montre ton travail via la todo list.`,
    streaming: true,
  },
  "agency-marketing": {
    projectDir: "/home/xavier/xklip",
    systemPrompt: `Tu es Jarvis, agent marketing. Content, SEO, réseaux sociaux.
Réponds en français.`,
    streaming: true,
  },
  "agency-sales": {
    projectDir: "/home/xavier/xklip",
    systemPrompt: `Tu es Jarvis, agent commercial. Prospection, outreach, suivi leads.
Réponds en français.`,
    streaming: true,
  },
  "liens": {
    projectDir: "/home/xavier/xklip",
    systemPrompt: `Tu es Jarvis. Quand tu reçois un lien URL, analyse-le et donne:
- Résumé (3-5 lignes)
- Pertinence business pour Xavier (freelance web dev, micro-SaaS)
- Application concrète possible
- Score d'intérêt /10
Réponds en français.`,
    streaming: false,
  },
  "ideas": {
    projectDir: "/home/xavier/xklip",
    systemPrompt: `Tu es Jarvis. Ce channel est pour brainstormer des idées.
Analyse chaque idée: faisabilité, potentiel, prochaines étapes.
Réponds en français.`,
    streaming: true,
  },
  "système": {
    projectDir: "/home/xavier/xklip",
    systemPrompt: `Tu es Jarvis, admin système. Tu gères le VPS, les crons, le monitoring.
Réponds en français, sois technique et précis.`,
    streaming: true,
  },
};

// Default config for channels not explicitly configured
export const DEFAULT_CHANNEL_CONFIG: Omit<ChannelConfig, "id" | "name"> = {
  projectDir: "/home/xavier/xklip",
  systemPrompt: `Tu es Jarvis, l'assistant IA de Xavier. Réponds en français, sois direct et utile.`,
  streaming: true,
};

export function getChannelConfig(channelId: string, channelName: string): ChannelConfig {
  const override = CHANNEL_CONFIGS[channelName] || {};
  return {
    id: channelId,
    name: channelName,
    ...DEFAULT_CHANNEL_CONFIG,
    ...override,
  };
}

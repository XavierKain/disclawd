import { Subprocess } from "bun";
import type { StreamEvent, TodoItem } from "./types.js";
import { CLAUDE_MODEL } from "./config.js";
import { updateSessionId, incrementMessageCount, getSession } from "./database.js";

export interface SessionCallbacks {
  onText: (text: string) => void;
  onTodoUpdate: (todos: TodoItem[]) => void;
  onToolUse: (toolName: string, toolInput: Record<string, unknown>) => void;
  onResult: (result: StreamEvent["result"]) => void;
  onError: (error: string) => void;
  onSessionId: (sessionId: string) => void;
  onHeartbeat: () => void;
}

interface ActiveProcess {
  proc: Subprocess;
  channelId: string;
  abortController: AbortController;
}

const activeProcesses = new Map<string, ActiveProcess>();

// Env vars to strip from subprocess (security)
const STRIPPED_ENV_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
];

function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && !STRIPPED_ENV_KEYS.includes(key)) {
      env[key] = value;
    }
  }
  return env;
}

export function isSessionActive(channelId: string): boolean {
  return activeProcesses.has(channelId);
}

export function getActiveSessionCount(): number {
  return activeProcesses.size;
}

export async function stopSession(channelId: string): Promise<void> {
  const active = activeProcesses.get(channelId);
  if (!active) return;

  // Graceful: SIGINT first (like pressing Escape in Claude Code)
  active.proc.kill("SIGINT");

  // Wait up to 10s, then force kill
  const timeout = setTimeout(() => {
    try { active.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { active.proc.kill("SIGKILL"); } catch {}
    }, 2000);
  }, 10000);

  try {
    await active.proc.exited;
  } finally {
    clearTimeout(timeout);
    activeProcesses.delete(channelId);
  }
}

export async function sendMessage(
  channelId: string,
  channelName: string,
  message: string,
  projectDir: string,
  systemPrompt: string,
  callbacks: SessionCallbacks,
  memories: string[] = [],
): Promise<void> {
  // If session is already active, stop it first (user sent new message)
  if (isSessionActive(channelId)) {
    await stopSession(channelId);
  }

  const session = getSession(channelId);
  const sessionId = session?.session_id;

  // Build the full system prompt with memories
  let fullSystemPrompt = systemPrompt;
  if (memories.length > 0) {
    fullSystemPrompt += "\n\n## Mémoire de ce channel\n" + memories.join("\n---\n");
  }

  // Build claude command args
  const args: string[] = [
    "claude",
    "-p",
    "--output-format", "stream-json",
    "--model", CLAUDE_MODEL,
    "--verbose",
    "--dangerously-skip-permissions",
    "--system-prompt", fullSystemPrompt,
  ];

  // Resume existing session if we have one
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  // Add the message
  args.push(message);

  const abortController = new AbortController();
  const env = buildCleanEnv();

  const proc = Bun.spawn(args, {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  });

  activeProcesses.set(channelId, { proc, channelId, abortController });

  // Track todos from this session
  const todos: TodoItem[] = [];

  // Heartbeat timer
  const heartbeatInterval = setInterval(() => {
    if (activeProcesses.has(channelId)) {
      callbacks.onHeartbeat();
    }
  }, 15000);

  // Process stdout (stream-json)
  const processStream = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: StreamEvent = JSON.parse(line);
            handleStreamEvent(event, channelId, todos, callbacks);
          } catch {
            // Not valid JSON, skip
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event: StreamEvent = JSON.parse(buffer);
          handleStreamEvent(event, channelId, todos, callbacks);
        } catch {}
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        callbacks.onError(`Stream read error: ${err}`);
      }
    }
  };

  // Process stderr
  const processStderr = async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderrBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrBuffer += decoder.decode(value, { stream: true });
      }
    } catch {}

    // Filter out info/debug lines, only report real errors
    const errorLines = stderrBuffer
      .split("\n")
      .filter(l => l.trim() && !l.includes("INFO") && !l.includes("DEBUG") && !l.includes("Compressing"))
      .join("\n");

    if (errorLines.trim()) {
      callbacks.onError(errorLines.trim());
    }
  };

  // Close stdin immediately (we send the message via args)
  proc.stdin.end();

  // Run both streams concurrently
  await Promise.all([processStream(), processStderr()]);

  // Wait for process exit
  const exitCode = await proc.exited;
  clearInterval(heartbeatInterval);
  activeProcesses.delete(channelId);

  incrementMessageCount(channelId);

  if (exitCode !== 0 && exitCode !== null) {
    callbacks.onError(`Claude exited with code ${exitCode}`);
  }
}

function handleStreamEvent(
  event: StreamEvent,
  channelId: string,
  todos: TodoItem[],
  callbacks: SessionCallbacks,
) {
  // Capture session ID
  if (event.session_id) {
    updateSessionId(channelId, event.session_id);
    callbacks.onSessionId(event.session_id);
  }

  switch (event.type) {
    case "system":
      // Handle init event which contains session_id
      if (event.subtype === "init" && event.session_id) {
        updateSessionId(channelId, event.session_id);
        callbacks.onSessionId(event.session_id);
      }
      break;

    case "assistant":
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            callbacks.onText(block.text);
          }
          if (block.type === "tool_use" && block.name) {
            callbacks.onToolUse(block.name, block.input || {});

            // Intercept TaskCreate / TaskUpdate
            if (block.name === "TaskCreate" && block.input) {
              const input = block.input as any;
              const newTodo: TodoItem = {
                id: String(todos.length + 1),
                subject: input.subject || "Untitled",
                status: "pending",
                description: input.description,
              };
              todos.push(newTodo);
              callbacks.onTodoUpdate([...todos]);
            }
            if (block.name === "TaskUpdate" && block.input) {
              const input = block.input as any;
              const todo = todos.find(t => t.id === input.taskId);
              if (todo) {
                if (input.status) todo.status = input.status;
                if (input.subject) todo.subject = input.subject;
                callbacks.onTodoUpdate([...todos]);
              }
            }
          }
        }
      }
      break;

    case "result":
      callbacks.onResult(event.result || null);
      break;
  }
}

// Graceful shutdown: stop all active sessions
export async function shutdownAll(): Promise<void> {
  const channels = Array.from(activeProcesses.keys());
  await Promise.all(channels.map(ch => stopSession(ch)));
}

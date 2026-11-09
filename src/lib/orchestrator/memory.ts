import type { MemorySlots, MemorySnapshot, RouteDecision } from "./types";

interface SessionState {
  turns: number;
  slots: MemorySlots;
  recent: { role: "user" | "assistant"; text: string }[];
}

const MAX_SESSIONS = 200;
const sessions = new Map<string, SessionState>();

function emptySession(): SessionState {
  return { turns: 0, slots: {}, recent: [] };
}

export function readMemory(sessionId: string): MemorySnapshot {
  const session = sessions.get(sessionId) ?? emptySession();
  return {
    turns: session.turns,
    slots: { ...session.slots },
    recent: session.recent.slice(-4),
  };
}

export function writeMemory(
  sessionId: string,
  input: {
    userText: string;
    assistantText: string;
    lastIntent: RouteDecision["intent"];
    orderId?: string;
    productSku?: string;
    productName?: string;
  },
): SessionState {
  if (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  const session = sessions.get(sessionId) ?? emptySession();
  session.turns += 1;
  session.slots.lastIntent = input.lastIntent;
  if (input.orderId) session.slots.orderId = input.orderId;
  if (input.productSku) {
    session.slots.productSku = input.productSku;
    session.slots.productName = input.productName;
  }
  session.recent = [
    ...session.recent,
    { role: "user" as const, text: input.userText },
    { role: "assistant" as const, text: input.assistantText },
  ].slice(-8);
  sessions.set(sessionId, session);
  return session;
}

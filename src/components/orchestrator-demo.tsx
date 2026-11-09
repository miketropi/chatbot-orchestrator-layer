"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, FaultMode, OrchestratorEvent } from "@/lib/orchestrator/types";
import { ChatPanel } from "./chat-panel";
import { TracePanel } from "./trace-panel";
import { FAULT_OPTIONS, FAULT_TARGETS } from "./labels";

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  text: [
    "Chào bạn 👋 Mình là trợ lý demo của lớp orchestration.",
    "",
    "Hãy chọn một câu hỏi gợi ý bên dưới, rồi nhìn sang phải: từng quyết định của orchestrator (route → plan → tool → compose) sẽ hiện ra theo thời gian thực.",
  ].join("\n"),
};

export function OrchestratorDemo() {
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [events, setEvents] = useState<OrchestratorEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [fault, setFault] = useState<FaultMode>("none");
  const [showNotes, setShowNotes] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [llm, setLlm] = useState<{ enabled: boolean; model?: string } | null>(null);
  const [useLlm, setUseLlm] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => {
        if (!cancelled && config) setLlm(config);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const applyEvent = useCallback((event: OrchestratorEvent, assistantId: string) => {
    if (event.type === "token") {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId ? { ...message, text: message.text + event.text } : message,
        ),
      );
      return;
    }

    setEvents((prev) => [...prev, event]);

    if (event.type === "compose_end") {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                citations: event.citations,
                suggestions: event.suggestions,
                degraded: event.degraded,
              }
            : message,
        ),
      );
    }
    if (event.type === "error") {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, text: message.text || `⚠️ ${event.message}` }
            : message,
        ),
      );
    }
  }, []);

  const send = useCallback(
    async (raw?: string) => {
      const text = (raw ?? draft).trim();
      if (!text || isRunning) return;

      setDraft("");
      setEvents([]);
      setIsRunning(true);

      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", text },
        { id: assistantId, role: "assistant", text: "", streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: text, fault, useLlm }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`API trả về HTTP ${response.status}.`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) applyEvent(JSON.parse(line) as OrchestratorEvent, assistantId);
            newline = buffer.indexOf("\n");
          }
        }
        if (buffer.trim()) applyEvent(JSON.parse(buffer) as OrchestratorEvent, assistantId);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          const message = error instanceof Error ? error.message : "Không gọi được API.";
          setEvents((prev) => [
            ...prev,
            { type: "error", t: 0, message, note: "Lỗi ở tầng client/network — server chưa kịp chạy run." },
          ]);
          setMessages((prev) =>
            prev.map((item) =>
              item.id === assistantId ? { ...item, text: item.text || `⚠️ ${message}` } : item,
            ),
          );
        }
      } finally {
        setIsRunning(false);
        abortRef.current = null;
        setMessages((prev) => prev.map((item) => (item.streaming ? { ...item, streaming: false } : item)));
      }
    },
    [applyEvent, draft, fault, isRunning, sessionId, useLlm],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setSessionId(crypto.randomUUID());
    setMessages([WELCOME]);
    setEvents([]);
    setDraft("");
    setIsRunning(false);
  }, []);

  const activeFault = FAULT_OPTIONS.find((option) => option.value === fault) ?? FAULT_OPTIONS[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2.5 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-slate-500">Fault injection</span>
          <div className="flex rounded-lg border border-white/10 bg-black/20 p-0.5">
            {FAULT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setFault(option.value)}
                className={`rounded-md px-2.5 py-1 text-[11.5px] transition ${
                  fault === option.value
                    ? "bg-white/10 text-slate-100 shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] leading-snug text-slate-500">{activeFault.hint}</span>
        </div>

        <div className="flex flex-wrap items-center gap-3 lg:ml-auto">
          {fault !== "none" && (
            <span className="hidden max-w-[320px] truncate font-mono text-[10px] text-slate-600 xl:inline">
              áp dụng: {FAULT_TARGETS.map((target) => target.tool).join(" · ")}
            </span>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-slate-400">
            <input
              type="checkbox"
              checked={showNotes}
              onChange={(event) => setShowNotes(event.target.checked)}
              className="size-3.5 accent-emerald-400"
            />
            Hiện giải thích
          </label>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-slate-400"
            title={
              llm?.enabled
                ? `Router/planner/composer gọi ${llm.model}`
                : "Chưa có ROUTER_API_KEY — sẽ luôn chạy rule-based"
            }
          >
            <input
              type="checkbox"
              checked={useLlm && Boolean(llm?.enabled)}
              disabled={!llm?.enabled}
              onChange={(event) => setUseLlm(event.target.checked)}
              className="size-3.5 accent-violet-400 disabled:opacity-40"
            />
            <span className={llm?.enabled ? "text-violet-200" : "text-slate-500"}>
              LLM {llm?.enabled ? "bật" : "chưa cấu hình"}
            </span>
          </label>
          <span className="hidden font-mono text-[10px] text-slate-600 sm:inline">
            session {sessionId.slice(0, 8)}
          </span>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-white/10 px-2.5 py-1.5 text-[11.5px] text-slate-300 transition hover:border-rose-400/40 hover:text-rose-200"
          >
            Session mới
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChatPanel
          messages={messages}
          isRunning={isRunning}
          draft={draft}
          onDraftChange={setDraft}
          onSend={send}
          onStop={() => abortRef.current?.abort()}
        />
        <TracePanel events={events} showNotes={showNotes} isRunning={isRunning} />
      </div>
    </div>
  );
}

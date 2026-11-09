"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/orchestrator/types";
import { QUICK_PROMPTS } from "./labels";

interface ChatPanelProps {
  messages: ChatMessage[];
  isRunning: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (text?: string) => void;
  onStop: () => void;
}

export function ChatPanel({ messages, isRunning, draft, onDraftChange, onSend, onStop }: ChatPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-[#0b1220]/80 shadow-2xl shadow-black/30 backdrop-blur">
      <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="size-2 rounded-full bg-emerald-400" />
        <h2 className="text-sm font-medium">Hội thoại</h2>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-slate-500">
          {isRunning ? "đang xử lý…" : "sẵn sàng"}
        </span>
      </header>

      <div
        ref={listRef}
        aria-live="polite"
        aria-relevant="additions text"
        className="flex h-[520px] flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        {messages.map((message, index) => (
          <article
            key={message.id}
            className={`flex flex-col gap-1.5 ${message.role === "user" ? "items-end" : "items-start"}`}
          >
            <div
              className={
                message.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-md bg-emerald-400/15 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-emerald-50"
                  : "max-w-[92%] rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-slate-200"
              }
            >
              <p className={`whitespace-pre-wrap ${message.streaming ? "cursor-blink" : ""}`}>
                {message.text || (message.streaming ? "" : "…")}
              </p>
              {message.degraded && (
                <span className="mt-2 inline-flex rounded-md border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-300">
                  degraded answer
                </span>
              )}
            </div>

            {message.citations && message.citations.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {message.citations.map((citation) => (
                  <span
                    key={`${citation.source}-${citation.title}`}
                    className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                  >
                    {citation.title} · {citation.source}
                  </span>
                ))}
              </div>
            )}

            {message.suggestions && message.suggestions.length > 0 && !message.streaming && (
              <div className="flex max-w-[92%] flex-wrap gap-1.5">
                {message.suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={isRunning}
                    onClick={() => onSend(suggestion)}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11.5px] text-slate-300 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

            {index === 0 && messages.length === 1 && (
              <div className="mt-1 flex w-full flex-wrap gap-1.5">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => onSend(prompt)}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-left text-[12px] text-slate-300 transition hover:border-emerald-400/40 hover:text-emerald-200"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>

      <form
        className="flex items-end gap-2 border-t border-white/10 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          rows={2}
          placeholder="Thử: Đơn #1002 tới đâu rồi? · Nó tới đâu rồi? · Hoàn tiền đơn 1004"
          className="min-h-[52px] flex-1 resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-[13.5px] text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-emerald-400/50"
        />
        {isRunning ? (
          <button
            type="button"
            onClick={onStop}
            className="h-[52px] rounded-xl border border-rose-400/40 bg-rose-400/10 px-4 text-[13px] font-medium text-rose-200 transition hover:bg-rose-400/20"
          >
            Dừng
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            className="h-[52px] rounded-xl bg-emerald-400 px-4 text-[13px] font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
          >
            Gửi
          </button>
        )}
      </form>
    </section>
  );
}

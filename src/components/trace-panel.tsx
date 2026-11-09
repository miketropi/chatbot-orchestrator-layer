"use client";

import { useEffect, useRef } from "react";
import type { Intent, OrchestratorEvent } from "@/lib/orchestrator/types";
import { INTENT_LABELS } from "./labels";

interface TracePanelProps {
  events: OrchestratorEvent[];
  showNotes: boolean;
  isRunning: boolean;
}

const STAGES = [
  { id: "guard", label: "Guard" },
  { id: "route", label: "Route" },
  { id: "plan", label: "Plan" },
  { id: "execute", label: "Execute" },
  { id: "compose", label: "Compose" },
] as const;

type VisibleStage = (typeof STAGES)[number]["id"];
type StageId = VisibleStage | "done";

const STEP_TONES = [
  "border-l-sky-400/70",
  "border-l-emerald-400/70",
  "border-l-violet-400/70",
  "border-l-amber-400/70",
  "border-l-rose-400/70",
  "border-l-cyan-400/70",
];

function stepTone(stepId: string): string {
  let hash = 0;
  for (let i = 0; i < stepId.length; i++) hash = (hash * 31 + stepId.charCodeAt(i)) | 0;
  return STEP_TONES[Math.abs(hash) % STEP_TONES.length];
}

function stageOf(event: OrchestratorEvent): StageId {
  switch (event.type) {
    case "run_start":
    case "guard":
    case "memory_recall":
      return "guard";
    case "route":
      return "route";
    case "plan":
      return "plan";
    case "step_start":
    case "step_retry":
    case "step_end":
    case "step_skip":
      return "execute";
    case "compose_start":
    case "token":
    case "compose_end":
      return "compose";
    case "run_end":
    case "error":
      return "done";
  }
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function computeStages(events: OrchestratorEvent[]) {
  const starts: Partial<Record<VisibleStage, number>> = {};
  let lastT = 0;

  for (const event of events) {
    lastT = Math.max(lastT, event.t);
    const stage = stageOf(event);
    if (stage !== "done" && starts[stage] === undefined) starts[stage] = event.t;
  }

  const current = events.length > 0 ? stageOf(events[events.length - 1]) : null;

  return STAGES.map((stage, index) => {
    const start = starts[stage.id];
    const nextStart = STAGES.slice(index + 1)
      .map((next) => starts[next.id])
      .find((value) => value !== undefined);
    const end = nextStart ?? (current === "done" ? lastT : undefined);
    return {
      ...stage,
      started: start !== undefined,
      active: current === stage.id,
      duration: start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined,
    };
  });
}

interface TraceStats {
  intent?: Intent;
  confidence?: number;
  tools: number;
  failed: number;
  skipped: number;
  totalMs?: number;
}

function readStats(events: OrchestratorEvent[]): TraceStats {
  const stats: TraceStats = { tools: 0, failed: 0, skipped: 0 };
  for (const event of events) {
    if (event.type === "route") {
      stats.intent = event.decision.intent;
      stats.confidence = event.decision.confidence;
    }
    if (event.type === "step_end") {
      stats.tools += 1;
      if (event.result.status !== "ok") stats.failed += 1;
    }
    if (event.type === "step_skip") stats.skipped += 1;
    if (event.type === "run_end") stats.totalMs = event.ms;
  }
  return stats;
}

function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "emerald" | "amber" | "sky" | "rose" | "violet";
}) {
  const tones = {
    slate: "border-white/10 bg-white/[0.03] text-slate-400",
    emerald: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    amber: "border-amber-400/30 bg-amber-400/10 text-amber-300",
    sky: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    rose: "border-rose-400/30 bg-rose-400/10 text-rose-300",
    violet: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  };
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tones[tone]}`}>{children}</span>
  );
}

function EngineChip({ engine }: { engine: "llm" | "rules" }) {
  return <Chip tone={engine === "llm" ? "violet" : "slate"}>{engine === "llm" ? "LLM" : "rules"}</Chip>;
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1.5 rounded-md border border-amber-400/20 bg-amber-400/[0.06] px-2 py-1 text-[10.5px] leading-relaxed text-amber-200/90">
      ⚠ {children}
    </p>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{children}</p>;
}

function EventBody({ event }: { event: OrchestratorEvent }) {
  switch (event.type) {
    case "run_start":
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] text-slate-400">{event.runId}</span>
            <Chip>fault: {event.fault}</Chip>
            {event.llm.enabled ? (
              <Chip tone="violet">{event.llm.model ?? "llm"}</Chip>
            ) : (
              <Chip>no key · rules</Chip>
            )}
            {event.llm.enabled && !event.llm.requested && <Chip tone="amber">LLM tắt cho lượt này</Chip>}
          </div>
          <p className="line-clamp-2 text-[12px] text-slate-400">“{event.message}”</p>
        </div>
      );
    case "guard":
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Chip tone={event.allowed ? "emerald" : "rose"}>{event.allowed ? "PASS" : "BLOCK"}</Chip>
            <span className="text-[12px] text-slate-300">{event.reason}</span>
          </div>
        </div>
      );
    case "memory_recall": {
      const { slots, turns } = event.memory;
      return (
        <div className="space-y-1.5">
          <p className="text-[12px] text-slate-400">
            {turns} lượt trước · {Object.keys(slots).length} slot
          </p>
          <div className="flex flex-wrap gap-1.5">
            {slots.orderId && <Chip tone="sky">orderId: {slots.orderId}</Chip>}
            {slots.productSku && (
              <Chip tone="sky">
                product: {slots.productName ?? slots.productSku}
              </Chip>
            )}
            {slots.lastIntent && <Chip>lastIntent: {INTENT_LABELS[slots.lastIntent]}</Chip>}
            {Object.keys(slots).length === 0 && <Chip>memory trống</Chip>}
          </div>
        </div>
      );
    }
    case "route": {
      const decision = event.decision;
      const topScore = Math.max(1, ...decision.candidates.map((candidate) => candidate.score));
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <EngineChip engine={event.engine} />
            <span className="text-sm font-semibold text-slate-100">{INTENT_LABELS[decision.intent]}</span>
            <span className="font-mono text-[11px] text-emerald-300">
              {Math.round(decision.confidence * 100)}% tin cậy
            </span>
            {decision.resolvedFromMemory && <Chip tone="sky">slot từ memory</Chip>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-emerald-400"
              style={{ width: `${Math.round(decision.confidence * 100)}%` }}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {decision.orderId && <Chip tone="sky">orderId: {decision.orderId}</Chip>}
            {decision.productTerm && <Chip>term: {decision.productTerm}</Chip>}
          </div>
          <ul className="space-y-1">
            {decision.candidates.map((candidate) => (
              <li key={candidate.intent} className="flex items-center gap-2 text-[11px]">
                <span className="w-28 shrink-0 truncate text-slate-400">{candidate.intent}</span>
                <span className="h-1 w-full max-w-24 overflow-hidden rounded-full bg-white/10">
                  <span
                    className="block h-full rounded-full bg-violet-400/70"
                    style={{ width: `${Math.round((candidate.score / topScore) * 100)}%` }}
                  />
                </span>
                <span className="font-mono text-slate-500">{candidate.score}</span>
              </li>
            ))}
          </ul>
          <ul className="space-y-0.5">
            {decision.rationale.map((line) => (
              <li key={line} className="text-[11px] text-slate-400">
                · {line}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "plan":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <EngineChip engine={event.engine} />
            <span className="text-[11px] text-slate-500">
              {event.engine === "llm" ? "plan do model sinh, đã validate registry + DAG" : "plan theo intent"}
            </span>
          </div>
          {event.steps.length === 0 ? (
            <p className="text-[12px] text-slate-400">Kế hoạch rỗng — không gọi tool nào.</p>
          ) : (
            <ul className="space-y-1.5">
              {event.steps.map((step) => (
                <li
                  key={step.id}
                  className={`rounded-md border border-white/5 border-l-2 bg-white/[0.02] px-2 py-1.5 ${stepTone(step.id)}`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] text-slate-500">{step.id}</span>
                    <span className="text-[12px] text-slate-200">{step.label}</span>
                    <Chip>{step.tool}</Chip>
                    {step.dependsOn.length > 0 && (
                      <span className="font-mono text-[10px] text-slate-500">
                        ⟵ {step.dependsOn.join(", ")}
                      </span>
                    )}
                    <span className="ml-auto flex gap-1">
                      <Chip tone={step.critical ? "rose" : "slate"}>
                        {step.critical ? "critical" : "optional"}
                      </Chip>
                    </span>
                  </div>
                  {step.args && Object.keys(step.args).length > 0 && (
                    <p className="mt-1 truncate font-mono text-[10px] text-sky-300/70">
                      args: {JSON.stringify(step.args)}
                    </p>
                  )}
                  {step.condition && (
                    <p className="mt-1 font-mono text-[10px] text-amber-300/80">when: {step.condition}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {event.warning && <Warning>{event.warning}</Warning>}
        </div>
      );
    case "step_start":
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="sky">run</Chip>
          <span className="font-mono text-[11px] text-slate-300">{event.stepId}</span>
          <span className="text-[12px] text-slate-300">{event.label}</span>
          <Chip>{event.tool}</Chip>
          <span className="font-mono text-[10px] text-slate-500">attempt {event.attempt}</span>
        </div>
      );
    case "step_retry":
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="amber">retry</Chip>
          <span className="font-mono text-[11px] text-slate-300">{event.stepId}</span>
          <span className="font-mono text-[10px] text-slate-500">→ attempt {event.attempt}</span>
          <span className="text-[11px] text-amber-200/90">{event.error}</span>
        </div>
      );
    case "step_end": {
      const ok = event.result.status === "ok";
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={ok ? "emerald" : "rose"}>{ok ? "ok" : "error"}</Chip>
            <span className="font-mono text-[11px] text-slate-300">{event.result.stepId}</span>
            <span className="font-mono text-[10px] text-slate-500">{formatMs(event.result.ms)}</span>
            {event.result.retries > 0 && <Chip tone="amber">{event.result.retries} retry</Chip>}
            {!event.critical && <Chip>optional</Chip>}
          </div>
          {ok && event.result.output !== undefined && (
            <details className="group">
              <summary className="cursor-pointer font-mono text-[10px] text-slate-500 hover:text-slate-300">
                output ▾
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-white/5 bg-black/40 p-2 font-mono text-[10.5px] leading-relaxed text-emerald-200/80">
                {JSON.stringify(event.result.output, null, 2)}
              </pre>
            </details>
          )}
          {!ok && <p className="text-[11px] text-rose-300/90">{event.result.error}</p>}
        </div>
      );
    }
    case "step_skip":
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="amber">skip</Chip>
          <span className="font-mono text-[11px] text-slate-300">{event.stepId}</span>
          <span className="text-[11px] text-slate-400">{event.reason}</span>
        </div>
      );
    case "compose_start":
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <EngineChip engine={event.engine} />
          <Chip>compose</Chip>
          {event.degraded && <Chip tone="amber">degraded</Chip>}
          <span className="text-[11px] text-slate-400">Ghép câu trả lời + trích dẫn + gợi ý.</span>
        </div>
      );
    case "compose_end":
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={event.degraded ? "amber" : "emerald"}>
              {event.citations.length} citation · {event.suggestions.length} suggestion
            </Chip>
          </div>
          {event.citations.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {event.citations.map((citation) => (
                <Chip key={`${citation.source}-${citation.title}`}>
                  {citation.title} · {citation.source}
                </Chip>
              ))}
            </div>
          )}
        </div>
      );
    case "run_end":
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone="emerald">done</Chip>
          <span className="font-mono text-[11px] text-slate-300">{formatMs(event.ms)}</span>
          <span className="text-[11px] text-slate-400">· tổng {event.turns} lượt trong session</span>
        </div>
      );
    case "error":
      return <p className="text-[12px] text-rose-300">{event.message}</p>;
    case "token":
      return null;
  }
}

const EVENT_TONES: Record<OrchestratorEvent["type"], string> = {
  run_start: "border-l-slate-400/60",
  guard: "border-l-emerald-400/70",
  memory_recall: "border-l-sky-400/60",
  route: "border-l-violet-400/70",
  plan: "border-l-indigo-400/70",
  step_start: "border-l-sky-400/60",
  step_retry: "border-l-amber-400/80",
  step_end: "border-l-emerald-400/60",
  step_skip: "border-l-amber-400/60",
  compose_start: "border-l-fuchsia-400/60",
  compose_end: "border-l-emerald-400/50",
  run_end: "border-l-slate-400/60",
  error: "border-l-rose-500/80",
  token: "border-l-slate-500/40",
};

function EventCard({ event, showNotes }: { event: OrchestratorEvent; showNotes: boolean }) {
  if (event.type === "token") return null;
  const tone =
    (event.type === "guard" && !event.allowed) ||
    (event.type === "step_end" && event.result.status !== "ok")
      ? "border-l-rose-500/80"
      : EVENT_TONES[event.type];
  return (
    <li
      className={`animate-fade-up rounded-lg border border-white/5 border-l-2 bg-white/[0.025] px-3 py-2 ${tone}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-slate-500">
          {event.type.replace("_", " ")}
        </span>
        <span className="ml-auto font-mono text-[9.5px] text-slate-600">+{event.t}ms</span>
      </div>
      <EventBody event={event} />
      {showNotes && <Note>{event.note}</Note>}
    </li>
  );
}

export function TracePanel({ events, showNotes, isRunning }: TracePanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stages = computeStages(events);
  const stats = readStats(events);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [events]);

  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-white/10 bg-[#0b1220]/80 shadow-2xl shadow-black/30 backdrop-blur">
      <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className={`size-2 rounded-full ${isRunning ? "animate-soft-pulse bg-amber-400" : "bg-sky-400"}`} />
        <h2 className="text-sm font-medium">Orchestrator trace</h2>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-slate-500">
          event stream
        </span>
      </header>

      <div className="border-b border-white/10 px-3 py-3">
        <ol className="grid grid-cols-5 gap-1.5">
          {stages.map((stage) => (
            <li
              key={stage.id}
              className={`rounded-lg border px-2 py-1.5 ${
                stage.active
                  ? "border-emerald-400/50 bg-emerald-400/10"
                  : stage.started
                    ? "border-white/10 bg-white/[0.03]"
                    : "border-white/5 bg-transparent"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`size-1.5 rounded-full ${
                    stage.active
                      ? "animate-soft-pulse bg-emerald-400"
                      : stage.started
                        ? "bg-emerald-400/60"
                        : "bg-slate-700"
                  }`}
                />
                <span
                  className={`text-[10.5px] font-medium ${stage.started ? "text-slate-200" : "text-slate-600"}`}
                >
                  {stage.label}
                </span>
              </div>
              <p className="mt-0.5 font-mono text-[9.5px] text-slate-500">
                {formatMs(stage.duration) || (stage.active ? "…" : "—")}
              </p>
            </li>
          ))}
        </ol>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Chip tone={stats.intent ? "sky" : "slate"}>
            intent: {stats.intent ? INTENT_LABELS[stats.intent] : "—"}
          </Chip>
          <Chip>
            confidence: {stats.confidence === undefined ? "—" : `${Math.round(stats.confidence * 100)}%`}
          </Chip>
          <Chip tone={stats.failed > 0 ? "amber" : "slate"}>
            tools: {stats.tools}
            {stats.failed > 0 ? ` · lỗi ${stats.failed}` : ""}
            {stats.skipped > 0 ? ` · skip ${stats.skipped}` : ""}
          </Chip>
          <Chip>total: {formatMs(stats.totalMs) || "—"}</Chip>
        </div>
      </div>

      <div ref={listRef} className="h-[430px] overflow-y-auto px-3 py-3">
        {events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-[13px] text-slate-400">Trace sẽ xuất hiện ở đây theo thời gian thực.</p>
            <p className="max-w-xs text-[11.5px] leading-relaxed text-slate-600">
              Mỗi sự kiện là một quyết định của orchestrator: chặn input, chấm intent, lập kế hoạch, gọi tool, retry,
              bỏ qua bước có điều kiện, rồi compose.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {events.map((event, index) => (
              <EventCard key={`${event.type}-${index}`} event={event} showNotes={showNotes} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

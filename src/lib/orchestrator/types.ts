export type Intent =
  | "order_status"
  | "refund"
  | "product"
  | "faq"
  | "human_handoff"
  | "smalltalk"
  | "unknown";

export type FaultMode = "none" | "retry" | "down";

export interface MemorySlots {
  orderId?: string;
  productSku?: string;
  productName?: string;
  lastIntent?: Intent;
}

export interface MemorySnapshot {
  turns: number;
  slots: MemorySlots;
  recent: { role: "user" | "assistant"; text: string }[];
}

export interface Citation {
  title: string;
  source: string;
}

export interface RouteCandidate {
  intent: Intent;
  score: number;
}

export type Engine = "llm" | "rules";

export interface RouteDecision {
  intent: Intent;
  confidence: number;
  candidates: RouteCandidate[];
  orderId?: string;
  productTerm?: string;
  resolvedFromMemory: boolean;
  rationale: string[];
  engine: Engine;
}

export interface PlanStepView {
  id: string;
  label: string;
  tool: string;
  dependsOn: string[];
  critical: boolean;
  condition?: string;
  note: string;
  args?: Record<string, unknown>;
}

export type StepStatus = "ok" | "error" | "skipped";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  ms: number;
  retries: number;
  output?: unknown;
  error?: string;
  reason?: string;
}

export type OrchestratorEvent =
  | {
      type: "run_start";
      t: number;
      runId: string;
      message: string;
      fault: FaultMode;
      llm: { enabled: boolean; requested: boolean; model?: string };
      note: string;
    }
  | { type: "guard"; t: number; allowed: boolean; reason: string; note: string }
  | { type: "memory_recall"; t: number; memory: MemorySnapshot; note: string }
  | {
      type: "route";
      t: number;
      decision: RouteDecision;
      engine: Engine;
      warning?: string;
      note: string;
    }
  | {
      type: "plan";
      t: number;
      steps: PlanStepView[];
      engine: Engine;
      warning?: string;
      note: string;
    }
  | {
      type: "step_start";
      t: number;
      stepId: string;
      tool: string;
      label: string;
      attempt: number;
      note: string;
    }
  | {
      type: "step_retry";
      t: number;
      stepId: string;
      attempt: number;
      error: string;
      note: string;
    }
  | {
      type: "step_end";
      t: number;
      result: StepResult;
      critical: boolean;
      note: string;
    }
  | { type: "step_skip"; t: number; stepId: string; reason: string; note: string }
  | {
      type: "compose_start";
      t: number;
      degraded: boolean;
      engine: Engine;
      note: string;
    }
  | { type: "token"; t: number; text: string }
  | {
      type: "compose_end";
      t: number;
      citations: Citation[];
      suggestions: string[];
      degraded: boolean;
      note: string;
    }
  | { type: "run_end"; t: number; ms: number; turns: number; note: string }
  | { type: "error"; t: number; message: string; note: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  suggestions?: string[];
  degraded?: boolean;
  streaming?: boolean;
}

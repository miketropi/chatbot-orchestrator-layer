import { chunkText, compose, type ComposeStep } from "./composer";
import { checkInput } from "./guard";
import { readMemory, writeMemory } from "./memory";
import { buildPlan, toViews, type PlanStep } from "./planner";
import { composeWithLlm, llmStatus, planWithLlm, routeWithLlm } from "./llm-stages";
import { routeMessage } from "./router";
import { TOOLS, ToolError } from "./tools";
import type {
  FaultMode,
  Intent,
  OrchestratorEvent,
  PlanStepView,
  StepResult,
} from "./types";
import { now, preview, round, sleep } from "./utils";

export interface RunInput {
  sessionId: string;
  message: string;
  fault: FaultMode;
  useLlm: boolean;
}

/** Which tool the fault switch breaks, per intent (so every route is demoable). */
const FAULT_TARGET: Record<Intent, string | null> = {
  order_status: "shipping.track",
  refund: "refund.check",
  product: "inventory.check",
  faq: "policy.search",
  human_handoff: "ticket.create",
  smalltalk: null,
  unknown: null,
};

const TOKEN_DELAY_MS = 16;

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  const gate = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    gate.reject(new ToolError(`Tool timeout sau ${ms}ms.`, true));
  }, ms);
  task.then(gate.resolve, gate.reject);
  return gate.promise.finally(() => clearTimeout(timer));
}

function stepResult(step: PlanStep, result: Omit<StepResult, "stepId">): StepResult {
  return { stepId: step.id, ...result };
}

export async function* runChat(input: RunInput): AsyncGenerator<OrchestratorEvent> {
  const startedAt = now();
  const at = () => round(now() - startedAt);
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  const memory = readMemory(input.sessionId);
  const llm = llmStatus();

  yield {
    type: "run_start",
    t: at(),
    runId,
    message: input.message,
    fault: input.fault,
    llm: { enabled: llm.enabled, requested: input.useLlm, model: llm.model },
    note: llm.enabled
      ? "Mỗi lượt chat là một run độc lập. Lượt này có LLM: router/planner/composer gọi model, mọi lỗi LLM đều fallback về rule-based."
      : "Mỗi lượt chat là một run độc lập, nhưng dùng chung memory của session. Chưa cấu hình ROUTER_API_KEY → toàn bộ chạy rule-based.",
  };

  const guard = checkInput(input.message);
  yield {
    type: "guard",
    t: at(),
    allowed: guard.allowed,
    reason: guard.reason,
    note: guard.allowed
      ? "Guard chạy trước mọi thứ: chặn input rỗng, quá dài hoặc có mẫu prompt injection."
      : "Guard chặn input → router/planner/tool không chạy, tiết kiệm chi phí và tránh side effect.",
  };

  if (!guard.allowed) {
    const refusal =
      "Mình không thể xử lý yêu cầu này vì nó vi phạm quy tắc an toàn của trợ lý. Bạn thử diễn đạt lại câu hỏi về đơn hàng, hoàn tiền, sản phẩm hoặc chính sách nhé.";
    yield {
      type: "compose_start",
      t: at(),
      degraded: false,
      engine: "rules",
      note: "Trả lời từ chối được soạn trực tiếp, không qua composer/dữ liệu tool.",
    };
    for (const chunk of chunkText(refusal)) {
      await sleep(TOKEN_DELAY_MS);
      yield { type: "token", t: at(), text: chunk };
    }
    yield {
      type: "compose_end",
      t: at(),
      citations: [],
      suggestions: ["Đơn #1002 tới đâu rồi?", "Gặp nhân viên"],
      degraded: false,
      note: "Kết thúc run sớm sau guardrail.",
    };
    writeMemory(input.sessionId, {
      userText: input.message,
      assistantText: refusal,
      lastIntent: "unknown",
    });
    yield {
      type: "run_end",
      t: at(),
      ms: at(),
      turns: memory.turns + 1,
      note: "Session vẫn ghi nhận lượt này để audit.",
    };
    return;
  }

  yield {
    type: "memory_recall",
    t: at(),
    memory,
    note:
      memory.turns > 0
        ? "Memory được nạp trước khi route để hiểu câu nối tiếp (ví dụ đại từ “nó”, “đơn đó”)."
        : "Lượt đầu tiên của session — memory rỗng.",
  };

  const ruleDecision = routeMessage(input.message, memory);
  const routeStage = input.useLlm
    ? await routeWithLlm(input.message, memory, ruleDecision)
    : { value: ruleDecision, engine: "rules" as const, warning: undefined };
  const decision = routeStage.value;
  yield {
    type: "route",
    t: at(),
    decision,
    engine: routeStage.engine,
    warning: routeStage.warning,
    note:
      decision.engine === "llm"
        ? "Router LLM phân loại theo ngữ nghĩa và trả JSON có schema. Confidence vẫn so với cùng ngưỡng 55% như bản rule."
        : "Router rule-based: chấm điểm từ khoá, chọn intent cao nhất kèm confidence. Dưới ngưỡng thì fallback thay vì đoán bừa.",
  };

  const planStage = input.useLlm
    ? await planWithLlm(decision, input.message)
    : { value: buildPlan(decision, input.message), engine: "rules" as const, warning: undefined };
  const plan = planStage.value;
  const views = toViews(plan.steps);
  const viewById = new Map(views.map((view) => [view.id, view]));
  yield {
    type: "plan",
    t: at(),
    steps: views,
    engine: planStage.engine,
    warning: planStage.warning,
    note: plan.note,
  };

  const results = new Map<string, StepResult>();
  const outputs: Record<string, unknown> = {};
  const pending = [...plan.steps];
  let degraded = false;

  while (pending.length > 0) {
    const ready: PlanStep[] = [];
    const skipped: { step: PlanStep; reason: string }[] = [];

    for (const step of pending) {
      if (!step.dependsOn.every((dep) => results.has(dep))) continue;
      const failedDep = step.dependsOn.find((dep) => results.get(dep)?.status !== "ok");
      if (failedDep) {
        const depStatus = results.get(failedDep)?.status;
        skipped.push({
          step,
          reason: `Phụ thuộc “${failedDep}” ${depStatus === "skipped" ? "bị bỏ qua" : "thất bại"}.`,
        });
      } else if (step.when && !step.when(outputs)) {
        skipped.push({ step, reason: `Điều kiện không thoả: ${step.condition}.` });
      } else {
        ready.push(step);
      }
    }

    for (const { step, reason } of skipped) {
      pending.splice(pending.indexOf(step), 1);
      results.set(step.id, stepResult(step, { status: "skipped", ms: 0, retries: 0, reason }));
      yield {
        type: "step_skip",
        t: at(),
        stepId: step.id,
        reason,
        note: "Executor bỏ qua bước này có chủ đích; không gọi tool, không tính là lỗi.",
      };
    }

    if (ready.length === 0) {
      if (skipped.length === 0) break; // safety: no progress (cycle)
      continue;
    }

    for (const step of ready) pending.splice(pending.indexOf(step), 1);

    const queue: OrchestratorEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: OrchestratorEvent) => {
      queue.push(event);
      wake?.();
      wake = null;
    };

    const executeStep = async (step: PlanStep): Promise<StepResult> => {
      const tool = TOOLS[step.tool];
      if (!tool) {
        return stepResult(step, { status: "error", ms: 0, retries: 0, error: `Tool ${step.tool} không tồn tại.` });
      }
      const args = step.resolveArgs(outputs);
      const missingArgs = (step.requiredArgs ?? []).filter(
        (key) => args[key] === undefined || args[key] === null || args[key] === "",
      );
      if (missingArgs.length > 0) {
        // A dependency ran but did not produce the field this step needs:
        // skip instead of calling the tool with undefined.
        const result = stepResult(step, {
          status: "skipped",
          ms: 0,
          retries: 0,
          reason: `thiếu tham số sau khi resolve: ${missingArgs.join(", ")}`,
        });
        push({
          type: "step_skip",
          t: at(),
          stepId: step.id,
          reason: result.reason ?? "",
          note: "Placeholder {{step.field}} trỏ tới field không tồn tại trong output — executor chặn thay vì gọi tool với undefined.",
        });
        return result;
      }
      const stepStarted = now();
      push({
        type: "step_start",
        t: at(),
        stepId: step.id,
        tool: step.tool,
        label: step.label,
        attempt: 1,
        note: `${step.note} Tool “${tool.name}”: ${tool.description} Gọi ${tool.maxAttempts} lần tối đa.`,
      });

      const faultTool = FAULT_TARGET[decision.intent];
      const faultInjected = () => input.fault !== "none" && faultTool === step.tool;
      let attempts = 0;
      let lastError = "";

      while (attempts < tool.maxAttempts) {
        attempts += 1;
        try {
          if (faultInjected() && (input.fault === "down" || attempts === 1)) {
            throw new ToolError(`Timeout giả lập: ${step.tool} không phản hồi.`, true);
          }
          const output = await withTimeout(tool.run(args, { sessionId: input.sessionId }), tool.timeoutMs);
          const result = stepResult(step, {
            status: "ok",
            ms: round(now() - stepStarted),
            retries: attempts - 1,
            output,
          });
          push({
            type: "step_end",
            t: at(),
            result,
            critical: step.critical,
            note: `Output → context của các bước sau. ${preview(output, 120)}`,
          });
          return result;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          const retryable = error instanceof ToolError ? error.retryable : true;
          if (!retryable || attempts >= tool.maxAttempts) break;
          push({
            type: "step_retry",
            t: at(),
            stepId: step.id,
            attempt: attempts + 1,
            error: lastError,
            note: `Retry ${attempts + 1}/${tool.maxAttempts}: chỉ thử lại lỗi tạm thời (timeout, 5xx); lỗi nghiệp vụ không retry.`,
          });
          await sleep(180);
        }
      }

      const result = stepResult(step, {
        status: "error",
        ms: round(now() - stepStarted),
        retries: attempts - 1,
        error: lastError,
      });
      push({
        type: "step_end",
        t: at(),
        result,
        critical: step.critical,
        note: step.critical
          ? "Bước critical lỗi → câu trả lời suy giảm; các bước phụ thuộc sẽ bị bỏ qua."
          : "Bước optional lỗi → vẫn compose được từ dữ liệu còn lại.",
      });
      return result;
    };

    const tasks = ready.map((step) =>
      executeStep(step).then((result) => {
        results.set(step.id, result);
        if (result.output === undefined) return;
        outputs[step.id] = result.output;
        // Models reference steps by semantic name ("lookup") or tool name
        // ("order.lookup") instead of the id we assigned. Register those as
        // aliases so `{{lookup.id}}` resolves to the same output.
        for (const alias of [step.tool, step.tool.split(".").pop() ?? step.tool]) {
          if (alias && outputs[alias] === undefined) outputs[alias] = result.output;
        }
        const slug = step.label
          .toLowerCase()
          .normalize("NFD")
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        if (slug && outputs[slug] === undefined) outputs[slug] = result.output;
      }),
    );
    let running = true;
    Promise.all(tasks).finally(() => {
      running = false;
      wake?.();
      wake = null;
    });

    while (running || queue.length > 0) {
      const event = queue.shift();
      if (event) {
        yield event;
        continue;
      }
      const gate = Promise.withResolvers<void>();
      wake = gate.resolve;
      if (!running && queue.length === 0) {
        wake = null;
        gate.resolve();
      }
      await gate.promise;
    }
  }

  degraded = plan.steps.some((step) => {
    const result = results.get(step.id);
    if (!result) return false;
    if (result.status === "error") return true;
    return step.critical && result.status === "skipped";
  });

  const composeSteps: ComposeStep[] = plan.steps.map((step) => ({
    view: viewById.get(step.id) as PlanStepView,
    result:
      results.get(step.id) ??
      stepResult(step, { status: "skipped", ms: 0, retries: 0, reason: "không chạy" }),
  }));

  const template = compose({
    message: input.message,
    decision,
    steps: composeSteps,
    outputs,
    memory,
  });

  const llmAnswer = input.useLlm
    ? await composeWithLlm({
        message: input.message,
        decision,
        steps: composeSteps,
        outputs,
        memory,
        fallback: {
          text: template.text,
          citations: template.citations,
          suggestions: template.suggestions,
        },
      })
    : null;
  const composeEngine = llmAnswer?.warning ? "rules" : input.useLlm ? "llm" : "rules";
  const answerText = llmAnswer?.text ?? template.text;
  const chunks = chunkText(answerText);

  yield {
    type: "compose_start",
    t: at(),
    degraded,
    engine: composeEngine,
    note: llmAnswer
      ? "Composer LLM chỉ được nhận TOOL_DATA + FAILED_STEPS, không thấy tool registry → không thể gọi tool hay bịa nguồn. Trả lời stream về client."
      : "Composer template: ghép dữ liệu tool trả về. Không có dữ kiện nào được sinh thêm (grounding).",
  };
  for (const chunk of chunks) {
    await sleep(TOKEN_DELAY_MS);
    yield { type: "token", t: at(), text: chunk };
  }
  yield {
    type: "compose_end",
    t: at(),
    citations: llmAnswer?.citations ?? template.citations,
    suggestions: llmAnswer?.suggestions ?? template.suggestions,
    degraded: template.degraded,
    note: llmAnswer?.warning
      ? `${llmAnswer.warning} Citation vẫn lấy từ tool output, không lấy từ model.`
      : "Gợi ý trả lời nhanh cũng do orchestrator chọn — UI chỉ render lại.",
  };

  const order = outputs.lookup as { id?: string } | undefined;
  const product = outputs.search as { sku?: string; name?: string } | undefined;
  const session = writeMemory(input.sessionId, {
    userText: input.message,
    assistantText: answerText,
    lastIntent: decision.intent,
    orderId: order?.id ?? decision.orderId,
    productSku: product?.sku,
    productName: product?.name,
  });

  yield {
    type: "run_end",
    t: at(),
    ms: at(),
    turns: session.turns,
    note: "Memory chỉ lưu slot + vài lượt gần nhất, không lưu toàn bộ transcript.",
  };
}

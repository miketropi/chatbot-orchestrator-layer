import { buildPlan, type Plan, type PlanStep } from "./planner";
import {
  chatJsonValidated,
  isLlmEnabled,
  llmSettings,
  LlmError,
  normalizeDecision,
  ROUTE_SCHEMA_HINT,
} from "./llm";
import type {
  Intent,
  MemorySnapshot,
  PlanStepView,
  RouteDecision,
  StepResult,
} from "./types";
import { TOOLS, wantsCatalogListing } from "./tools";

export interface Stage<T> {
  value: T;
  engine: "llm" | "rules";
  warning?: string;
}

const MAX_STEPS = 6;

/** Canonical args per tool. Anything else the model sends is dropped. */
const TOOL_ARGS: Record<string, string[]> = {
  "order.lookup": ["orderId"],
  "shipping.track": ["orderId"],
  "refund.check": ["orderId"],
  "policy.search": ["query"],
  "product.search": ["term"],
  "inventory.check": ["sku"],
  "ticket.create": ["subject", "priority", "summary"],
};

const REQUIRED_ARGS: Record<string, string[]> = {
  "order.lookup": ["orderId"],
  "shipping.track": ["orderId"],
  "refund.check": ["orderId"],
  "policy.search": ["query"],
  "product.search": ["term"],
  "inventory.check": ["sku"],
  "ticket.create": ["subject", "summary"],
};

/** Fields each tool returns; used in the planner prompt and to validate refs. */
const TOOL_RETURNS: Record<string, string[]> = {
  "order.lookup": ["id", "status", "items", "total", "placedAt", "deliveredAt", "carrier", "tracking", "eta", "refundEligible"],
  "shipping.track": ["carrier", "tracking", "eta", "checkpoint"],
  "refund.check": ["eligible", "reason", "amount", "policyId"],
  "policy.search": ["id", "title", "body"],
  "product.search": ["mode", "sku", "name", "price", "warrantyMonths", "count", "items"],
  "inventory.check": ["sku", "stock", "warehouse", "restockEta"],
  "ticket.create": ["id", "priority", "subject", "slaHours"],
};

/** `{{order.id}}` style refs inside an expression. */
function conditionRoots(expression: string): { stepId: string; root: string }[] {
  const refs: { stepId: string; root: string }[] = [];
  const pattern = /\{?\{?\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)/g;
  let match = pattern.exec(expression);
  while (match) {
    refs.push({ stepId: match[1], root: match[2].split(".")[0] });
    match = pattern.exec(expression);
  }
  return refs;
}

/** Synonyms models emit for the same slot. */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  "order.lookup": { id: "orderId", order_id: "orderId", orderNumber: "orderId", code: "orderId" },
  "shipping.track": {
    id: "orderId",
    order_id: "orderId",
    orderNumber: "orderId",
    trackingNumber: "orderId",
    tracking_number: "orderId",
  },
  "refund.check": { id: "orderId", order_id: "orderId", orderNumber: "orderId" },
  "policy.search": { q: "query", keyword: "query", question: "query", topic: "query" },
  "product.search": {
    product: "term",
    name: "term",
    query: "term",
    sku: "term",
    keyword: "term",
    all: "term",
    list: "term",
    mode: "term",
  },
  "inventory.check": { productSku: "sku", product_sku: "sku", id: "sku", product: "sku" },
  "ticket.create": { title: "subject", description: "summary", details: "summary", content: "summary" },
};

const INTENT_TOOL_HINTS: Partial<Record<Intent, string[]>> = {
  order_status: ["order.lookup", "policy.search", "shipping.track"],
  refund: ["order.lookup", "policy.search", "refund.check", "ticket.create"],
  product: ["product.search", "policy.search", "inventory.check"],
  faq: ["policy.search"],
  human_handoff: ["ticket.create"],
};

function argsHintFor(tool: string): string {
  switch (tool) {
    case "order.lookup":
    case "shipping.track":
    case "refund.check":
      return "{ orderId: string }";
    case "policy.search":
      return "{ query: string }";
    case "product.search":
      return "{ term: string }";
    case "inventory.check":
      return "{ sku: string }";
    case "ticket.create":
      return '{ subject: string, priority?: "normal" | "high", summary: string }';
    default:
      return "{}";
  }
}

function readPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, root);
}

/** Resolve `{{stepId.path}}` placeholders against previous step outputs. */
export function resolvePlaceholders(
  args: Record<string, unknown>,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  const resolveOne = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) {
      if (typeof value !== "string") return value;
      const whole = value.match(/^\{\{\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)\s*\}\}$/);
      if (whole) return readPath(outputs[whole[1]], whole[2]);
      return value.replace(
        /\{\{\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)\s*\}\}/g,
        (original, stepId: string, path: string) => {
          const resolved = readPath(outputs[stepId], path);
          return resolved === undefined ? original : String(resolved);
        },
      );
    }
    if (Array.isArray(value)) return value.map(resolveOne);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveOne(item)]),
    );
  };

  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, resolveOne(value)]));
}

/**
 * Condition parser. Models write conditions in several shapes; accept the
 * common ones and never eval code. Unrecognised conditions are dropped with a
 * note instead of failing the whole plan.
 *
 * Supported:
 *   {{step.field}} == true | "x" | 12
 *   {{step.field}} != false
 *   {{step.field}}                  (truthy)
 *   step.field exists / is true
 *   always / never
 */
export function parseCondition(
  expression: string,
): { when?: (outputs: Record<string, unknown>) => boolean; note?: string } {
  const expr = expression
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/^when\s+/i, "");

  if (!expr || /^(always|true|yes)$/i.test(expr)) return {};
  if (/^(never|false|no)$/i.test(expr)) return { when: () => false };

  const comparison = expr.match(
    /^\{?\{?\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)\s*\}?\}?\s*(===|!==|==|!=)\s*(.+?)\s*$/,
  );
  if (comparison) {
    const [, stepId, path, operator, rawLiteral] = comparison;
    const literal = rawLiteral.replace(/^["'`]|["'`]$/g, "").trim();
    const expected =
      literal === "true"
        ? true
        : literal === "false"
          ? false
          : literal === "null"
            ? null
            : literal !== "" && !Number.isNaN(Number(literal))
              ? Number(literal)
              : literal;
    const strict = operator.startsWith("=");
    // Compare numbers as numbers, everything else as strings: `"1002" == 1002`
    // must be true when the model writes the order id as a number.
    const equals = (actual: unknown): boolean => {
      if (actual === expected) return true;
      if (actual === null || actual === undefined) return false;
      if (typeof actual === "number" && typeof expected === "string" && expected !== "") {
        return actual === Number(expected);
      }
      if (typeof actual === "string" && typeof expected === "number") {
        return actual === String(expected);
      }
      return false;
    };
    return {
      when: (outputs) => {
        const actual = readPath(outputs[stepId], path);
        return strict ? equals(actual) : !equals(actual);
      },
    };
  }

  const truthy = expr.match(
    /^\{?\{?\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)\s*\}?\}?\s*(?:exists?|is\s+(?:present|true|set|available))?$/i,
  );
  if (truthy) {
    const [, stepId, path] = truthy;
    return {
      when: (outputs) => {
        const actual = readPath(outputs[stepId], path);
        return actual !== undefined && actual !== null && actual !== false && actual !== "";
      },
    };
  }

  return { note: `bỏ điều kiện không hiểu: “${expression.trim().slice(0, 40)}”` };
}

interface LlmPlanStep {
  id?: unknown;
  label?: unknown;
  tool?: unknown;
  dependsOn?: unknown;
  critical?: unknown;
  when?: unknown;
  args?: unknown;
}

function sanitizeArgs(toolName: string, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const allowed = TOOL_ARGS[toolName] ?? [];
  const aliases = ARG_ALIASES[toolName] ?? {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const canonical = allowed.includes(key) ? key : aliases[key];
    if (canonical && !(canonical in out)) out[canonical] = value;
  }
  return out;
}

interface SlotContext {
  orderId?: string;
  productTerm?: string;
  message: string;
}

/**
 * Deterministic repair for the args models most often omit. Beats failing the
 * whole plan: the slot is already known, or derivable from a sibling step.
 */
function fillMissingArgs(
  toolName: string,
  args: Record<string, unknown>,
  ctx: SlotContext,
  siblings: { id: string; tool: string }[],
  warnings: string[],
): Record<string, unknown> {
  const out = { ...args };
  const needs = (key: string) => out[key] === undefined || out[key] === null || out[key] === "";

  if ((toolName === "order.lookup" || toolName === "shipping.track" || toolName === "refund.check") && needs("orderId")) {
    if (ctx.orderId) {
      out.orderId = ctx.orderId;
      warnings.push(`${toolName}: điền orderId từ slot (${ctx.orderId}).`);
    }
  }

  if (toolName === "product.search" && needs("term")) {
    // A "list everything" question must not be turned into a single-product lookup.
    if (wantsCatalogListing(ctx.message)) {
      out.term = "*";
      warnings.push('product.search: câu hỏi liệt kê → term="*".');
    } else if (ctx.productTerm) {
      out.term = ctx.productTerm;
      warnings.push("product.search: điền term từ slot sản phẩm.");
    }
  }

  if (toolName === "policy.search" && needs("query")) {
    out.query = ctx.message.slice(0, 120);
    warnings.push("policy.search: điền query từ câu hỏi người dùng.");
  }

  if (toolName === "ticket.create") {
    if (needs("subject")) out.subject = "Yêu cầu hỗ trợ";
    if (needs("summary")) out.summary = ctx.message.slice(0, 200);
  }

  // inventory.check needs a SKU that only product.search can produce.
  // Skip it entirely for a full-catalog listing (no single SKU to check).
  if (toolName === "inventory.check" && needs("sku")) {
    const producers = siblings.filter((sibling) => sibling.tool === "product.search");
    if (producers.length === 1) {
      out.sku = `{{${producers[0].id}.sku}}`;
      warnings.push(`inventory.check: sku lấy từ bước ${producers[0].id}.`);
    }
  }

  return out;
}

function validateLlmPlan(rawSteps: LlmPlanStep[], ctx: SlotContext): Plan {
  if (rawSteps.length > MAX_STEPS) {
    throw new LlmError(`LLM trả ${rawSteps.length} bước, vượt giới hạn ${MAX_STEPS}.`, true);
  }

  const warnings: string[] = [];
  const drafts: {
    id: string;
    tool: string;
    label: string;
    critical: boolean;
    condition?: string;
    when?: (outputs: Record<string, unknown>) => boolean;
    args: Record<string, unknown>;
    dependsOn: string[];
    note: string;
  }[] = [];
  const seen = new Set<string>();

  for (const raw of rawSteps) {
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || !/^[a-z0-9_]{1,24}$/.test(id)) {
      throw new LlmError(`Bước có id không hợp lệ: ${JSON.stringify(raw.id)}.`, true);
    }
    if (seen.has(id)) throw new LlmError(`Trùng id bước “${id}”.`, true);
    seen.add(id);

    const toolName = typeof raw.tool === "string" ? raw.tool.trim() : "";
    const tool = TOOLS[toolName];
    if (!tool) {
      throw new LlmError(
        `Tool “${toolName}” không có trong registry. Chỉ dùng: ${Object.keys(TOOLS).join(", ")}.`,
        true,
      );
    }

    const args = sanitizeArgs(toolName, raw.args);

    const condition = typeof raw.when === "string" && raw.when.trim() ? raw.when.trim() : undefined;
    const parsedCondition = condition ? parseCondition(condition) : {};
    if (parsedCondition.note) warnings.push(parsedCondition.note);

    if (condition && parsedCondition.when) {
      for (const ref of conditionRoots(condition)) {
        const target = drafts.find((draft) => draft.id === ref.stepId);
        if (!target) continue;
        const fields = TOOL_RETURNS[target.tool] ?? [];
        if (!fields.includes(ref.root)) {
          throw new LlmError(
            `Điều kiện “${condition}” dùng field “${ref.root}” nhưng ${target.tool} chỉ trả: ${fields.join(", ")}.`,
            true,
          );
        }
      }
    }

    drafts.push({
      id,
      tool: toolName,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 40) : tool.label,
      critical: raw.critical !== false,
      condition,
      when: parsedCondition.when,
      args,
      dependsOn: Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter((dep): dep is string => typeof dep === "string" && dep.trim() !== "")
        : [],
      note: `LLM chọn: ${tool.description}`,
    });
  }

  for (const draft of drafts) {
    const filled = fillMissingArgs(
      draft.tool,
      draft.args,
      ctx,
      drafts.map((sibling) => ({ id: sibling.id, tool: sibling.tool })),
      warnings,
    );
    const missing = (REQUIRED_ARGS[draft.tool] ?? []).filter(
      (name) => filled[name] === undefined || filled[name] === null || filled[name] === "",
    );
    if (missing.length > 0) {
      throw new LlmError(
        `Bước “${draft.id}” (${draft.tool}) thiếu tham số ${missing.join(", ")} và không suy ra được từ slot. ` +
          `Chữ ký đúng: ${draft.tool}(${argsHintFor(draft.tool)}).`,
        true,
      );
    }
    draft.args = filled;
  }

  // Resolve dependencies against every declared id: models often reference a
  // step declared later in the array.
  // An args placeholder implies a dependency even when the model forgot it.
  for (const draft of drafts) {
    for (const value of Object.values(draft.args)) {
      if (typeof value !== "string") continue;
      for (const ref of conditionRoots(value)) {
        if (ref.stepId !== draft.id && !draft.dependsOn.includes(ref.stepId)) {
          draft.dependsOn.push(ref.stepId);
          warnings.push(`${draft.id}: thêm phụ thuộc ${ref.stepId} do dùng placeholder.`);
        }
      }
    }
  }

  const ids = new Set(drafts.map((draft) => draft.id));
  for (const draft of drafts) {
    const unknown = draft.dependsOn.filter((dep) => !ids.has(dep) || dep === draft.id);
    if (unknown.length > 0) {
      throw new LlmError(
        `Bước “${draft.id}” phụ thuộc bước không tồn tại: ${unknown.join(", ")}. ` +
          `Các id hợp lệ: ${[...ids].join(", ")}.`,
        true,
      );
    }
  }

  const steps: PlanStep[] = drafts.map((draft) => ({
    id: draft.id,
    label: draft.label,
    tool: draft.tool,
    dependsOn: draft.dependsOn,
    critical: draft.critical,
    condition: draft.when ? draft.condition : undefined,
    note: draft.when && draft.condition ? `${draft.note} (điều kiện: ${draft.condition})` : draft.note,
    args: draft.args,
    resolveArgs: (outputs) => resolvePlaceholders(draft.args, outputs),
    when: draft.when,
    requiredArgs: REQUIRED_ARGS[draft.tool] ?? [],
  }));

  const indegree = new Map(steps.map((step) => [step.id, step.dependsOn.length]));
  const queue = steps.filter((step) => step.dependsOn.length === 0).map((step) => step.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const step of steps) {
      if (!step.dependsOn.includes(id)) continue;
      const next = (indegree.get(step.id) ?? 0) - 1;
      indegree.set(step.id, next);
      if (next === 0) queue.push(step.id);
    }
  }
  if (visited !== steps.length) throw new LlmError("Kế hoạch của LLM có vòng phụ thuộc.", true);

  return {
    steps,
    note: ["Kế hoạch do LLM sinh, đã validate registry + DAG.", ...warnings].join(" "),
  };
}

export async function routeWithLlm(
  message: string,
  memory: MemorySnapshot,
  fallback: RouteDecision,
): Promise<Stage<RouteDecision>> {
  if (!isLlmEnabled()) {
    return {
      value: fallback,
      engine: "rules",
      warning: "Chưa có ROUTER_API_KEY → dùng router rule-based.",
    };
  }

  try {
    const parsed = await chatJsonValidated<Partial<RouteDecision> & { rationale?: string[] }>(
      [
        {
          role: "system",
          content: [
            "Bạn là router của chatbot CSKH tiếng Việt cho một shop bán lẻ thiết bị.",
            "Phân loại ý định người dùng, trích mã đơn và từ khoá sản phẩm nếu có.",
            'Nếu câu nói mơ hồ hoặc không thuộc các intent, trả intent "unknown" với confidence thấp.',
            "confidence phải phản ánh thật: câu rõ ràng > 0.8, câu mơ hồ < 0.55.",
            ROUTE_SCHEMA_HINT,
            "Chỉ trả JSON, không thêm chữ nào khác.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            message,
            memorySlots: memory.slots,
            recentTurns: memory.recent.slice(-2),
          }),
        },
      ],
      {
        maxTokens: 400,
        label: "router",
        validate: (value) => {
          if (!value || typeof value !== "object" || !("intent" in value)) {
            throw new LlmError("Router thiếu field intent.", true, JSON.stringify(value));
          }
          return value;
        },
      },
    );

    const decision = normalizeDecision(parsed, fallback);
    // Confidence threshold behaviour must not depend on which engine runs.
    if (decision.intent !== "unknown" && decision.confidence < 0.55) {
      return {
        engine: "llm",
        value: {
          ...decision,
          intent: "unknown",
          rationale: [
            ...decision.rationale,
            `Tin cậy ${(decision.confidence * 100).toFixed(0)}% < ngưỡng 55% → fallback.`,
          ],
        },
      };
    }
    if (decision.intent === "unknown") {
      return {
        engine: "llm",
        value: { ...decision, orderId: parsed.orderId ? decision.orderId : undefined },
      };
    }
    return { engine: "llm", value: decision };
  } catch (error) {
    const detail = error instanceof LlmError ? error.message : String(error);
    const warning = `LLM router lỗi (${detail}) → fallback rule-based.`;
    return { engine: "rules", value: { ...fallback, rationale: [...fallback.rationale, warning] }, warning };
  }
}

export async function planWithLlm(decision: RouteDecision, message: string): Promise<Stage<Plan>> {
  const fallback = buildPlan(decision, message);
  if (!isLlmEnabled()) {
    return { value: fallback, engine: "rules", warning: "Chưa có ROUTER_API_KEY → dùng planner theo intent." };
  }
  if (decision.intent === "smalltalk" || decision.intent === "unknown") {
    return { value: fallback, engine: "rules" };
  }

  const allowed = INTENT_TOOL_HINTS[decision.intent] ?? Object.keys(TOOLS);
  const manifest = allowed
    .filter((name) => TOOLS[name])
    .map((name) => ({
      tool: name,
      what: TOOLS[name].description,
      args: argsHintFor(name),
      optionalArgs: TOOL_ARGS[name].filter((arg) => !(REQUIRED_ARGS[name] ?? []).includes(arg)),
      returns: TOOL_RETURNS[name] ?? [],
    }));

  try {
    const plan = await chatJsonValidated<Plan>(
      [
        {
          role: "system",
          content: [
            "Bạn là planner của một chatbot CSKH. Nhiệm vụ: chọn các tool cần gọi và khai báo phụ thuộc dữ liệu.",
            "Quy tắc bắt buộc:",
            "1. CHỈ dùng tool trong danh sách. Không bịa tool.",
            "2. Bước chỉ được phụ thuộc bước có trong cùng kế hoạch (dependsOn là danh sách id).",
            "3. Hai bước độc lập phải có dependsOn rỗng để chạy song song. Đừng xếp chuỗi khi không cần.",
            "4. Truyền dữ liệu giữa các bước bằng placeholder dạng {{id.field}}, trong đó id là id bước và field nằm đúng trong `returns` của tool tương ứng.",
            "5. Bước ghi dữ liệu (ticket.create) phải critical=false và chỉ chạy khi có điều kiện dạng {{id.field}} == true với field tồn tại trong returns (ví dụ refund.check trả eligible).",
            "6. critical=true chỉ khi thiếu kết quả thì không thể trả lời.",
            "7. Tối đa 6 bước. Không cần bước nào thì trả steps rỗng.",
            'Trả JSON: { "steps": [ { "id", "label", "tool", "dependsOn", "critical", "args", "when" } ], "note": string }',
            "Không thêm markdown, không giải thích ngoài JSON.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            userMessage: message,
            intent: decision.intent,
            confidence: decision.confidence,
            slots: { orderId: decision.orderId ?? null, productTerm: decision.productTerm ?? null },
            allowedTools: manifest,
          }),
        },
      ],
      {
        maxTokens: 1200,
        label: "planner",
        validate: (value) => {
          const parsed = value as { steps?: LlmPlanStep[]; note?: string };
          if (!Array.isArray(parsed.steps)) {
            throw new LlmError("Planner trả thiếu mảng steps.", true, JSON.stringify(parsed).slice(0, 400));
          }
          const validated = validateLlmPlan(parsed.steps, {
            orderId: decision.orderId,
            productTerm: decision.productTerm,
            message,
          });
          if (typeof parsed.note === "string" && parsed.note.trim()) {
            validated.note = `${validated.note} Ghi chú model: ${parsed.note.trim().slice(0, 160)}`;
          }
          return validated;
        },
      },
    );

    return { value: plan, engine: "llm" };
  } catch (error) {
    const detail = error instanceof LlmError ? error.message : String(error);
    const warning = `LLM planner lỗi (${detail}) → fallback planner theo intent.`;
    return { value: { ...fallback, note: `${fallback.note} ${warning}` }, engine: "rules", warning };
  }
}

/** Used by the config endpoint so the client can show the actual engine. */
export function llmStatus() {
  const settings = llmSettings();
  return {
    enabled: settings !== null,
    model: settings?.model,
    baseUrl: settings?.baseUrl,
  };
}

export interface LlmComposeInput {
  message: string;
  decision: RouteDecision;
  steps: { view: PlanStepView; result: StepResult }[];
  outputs: Record<string, unknown>;
  memory: MemorySnapshot;
  fallback: { text: string; citations: { title: string; source: string }[]; suggestions: string[] };
}

export interface LlmComposeResult {
  text: string;
  citations: { title: string; source: string }[];
  suggestions: string[];
  warning?: string;
}

export async function composeWithLlm(input: LlmComposeInput): Promise<LlmComposeResult> {
  if (!isLlmEnabled()) {
    return { ...input.fallback, warning: "Chưa có ROUTER_API_KEY → composer template." };
  }

  const toolEvidence = input.steps
    .filter((step) => step.result.status === "ok")
    .map((step) => ({ step: step.view.id, tool: step.view.tool, output: step.result.output }));
  const failures = input.steps
    .filter((step) => step.result.status !== "ok")
    .map((step) => ({
      step: step.view.id,
      status: step.result.status,
      detail: step.result.error ?? step.result.reason,
    }));

  try {
    const parsed = await chatJsonValidated<{ answer?: unknown; suggestions?: unknown }>(
      [
        {
          role: "system",
          content: [
            'Bạn là trợ lý CSKH tiếng Việt của một shop thiết bị. Trả lời ngắn gọn, thân thiện, xưng "mình".',
            "QUY TẮC GROUNDING (bắt buộc):",
            "1. Chỉ dùng dữ kiện trong TOOL_DATA. Không suy ra, không bịa mã đơn, giá, ngày, số tiền.",
            "2. Nếu TOOL_DATA thiếu dữ kiện cần thiết, nói rõ là chưa kiểm tra được và đề nghị chuyển nhân viên.",
            "3. Nếu có bước lỗi trong FAILED_STEPS, thừa nhận giới hạn thay vì đoán kết quả.",
            "4. Không hứa hẹn ngoài chính sách trả về (thời hạn, số tiền hoàn, SLA).",
            'Trả JSON: { "answer": string, "suggestions": string[] } — 2-3 câu hỏi tiếp theo, mỗi câu < 40 ký tự.',
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            userMessage: input.message,
            intent: input.decision.intent,
            memorySlots: input.memory.slots,
            TOOL_DATA: toolEvidence,
            FAILED_STEPS: failures,
          }),
        },
      ],
      {
        maxTokens: 900,
        label: "composer",
        validate: (value) => {
          if (typeof value?.answer !== "string" || !value.answer.trim()) {
            throw new LlmError("Composer trả answer rỗng.", true, JSON.stringify(value));
          }
          return value;
        },
      },
    );

    const suggestionList = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((item) => item.trim().slice(0, 48))
          .slice(0, 3)
      : [];

    return {
      text: (parsed.answer as string).trim(),
      citations: input.fallback.citations,
      suggestions: suggestionList.length > 0 ? suggestionList : input.fallback.suggestions,
    };
  } catch (error) {
    return {
      ...input.fallback,
      warning: `LLM composer lỗi (${(error as Error).message}) → dùng composer template.`,
    };
  }
}

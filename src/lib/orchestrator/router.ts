import type { Intent, MemorySnapshot, RouteCandidate, RouteDecision } from "./types";

interface Rule {
  intent: Intent;
  keywords: { term: string; weight: number }[];
}

/**
 * Rule-based for the demo so the decision is legible.
 *
 * Seam for a real system: keep the RouteDecision contract and replace this
 * function with an LLM call using tool/JSON schema structured output
 * (e.g. { intent, confidence, orderId, productTerm }). The rest of the
 * orchestrator does not change.
 */
const RULES: Rule[] = [
  {
    intent: "order_status",
    keywords: [
      { term: "đơn hàng", weight: 3 },
      { term: "đơn", weight: 2 },
      { term: "giao", weight: 3 },
      { term: "tới đâu", weight: 4 },
      { term: "đến đâu", weight: 3 },
      { term: "vận chuyển", weight: 3 },
      { term: "ship", weight: 2 },
      { term: "tracking", weight: 3 },
      { term: "bao giờ", weight: 2 },
      { term: "khi nào", weight: 2 },
      { term: "nhận hàng", weight: 2 },
    ],
  },
  {
    intent: "refund",
    keywords: [
      { term: "hoàn tiền", weight: 5 },
      { term: "hoàn lại", weight: 4 },
      { term: "trả hàng", weight: 3 },
      { term: "đổi trả", weight: 3 },
      { term: "refund", weight: 4 },
      { term: "trả lại", weight: 3 },
      { term: "huỷ đơn", weight: 3 },
    ],
  },
  {
    intent: "product",
    keywords: [
      { term: "sản phẩm nào", weight: 5 },
      { term: "liệt kê", weight: 4 },
      { term: "danh sách", weight: 4 },
      { term: "list", weight: 3 },
      { term: "những sản phẩm", weight: 4 },
      { term: "danh sách sản phẩm", weight: 5 },
      { term: "shop có gì", weight: 5 },
      { term: "bán những gì", weight: 5 },
      { term: "có những gì", weight: 4 },
      { term: "còn hàng", weight: 5 },
      { term: "tồn kho", weight: 4 },
      { term: "sản phẩm", weight: 2 },
      { term: "mua", weight: 2 },
      { term: "giá", weight: 2 },
      { term: "có sẵn", weight: 3 },
      { term: "còn không", weight: 3 },
    ],
  },
  {
    intent: "faq",
    keywords: [
      { term: "chính sách", weight: 5 },
      { term: "quy định", weight: 4 },
      { term: "bảo hành", weight: 4 },
      { term: "thanh toán", weight: 3 },
      { term: "hóa đơn", weight: 3 },
      { term: "quy trình", weight: 3 },
      { term: "là gì", weight: 2 },
      { term: "như thế nào", weight: 2 },
    ],
  },
  {
    intent: "human_handoff",
    keywords: [
      { term: "nhân viên", weight: 5 },
      { term: "người thật", weight: 5 },
      { term: "hỗ trợ viên", weight: 3 },
      { term: "hotline", weight: 3 },
      { term: "khiếu nại", weight: 3 },
      { term: "gặp", weight: 2 },
    ],
  },
  {
    intent: "smalltalk",
    keywords: [
      { term: "xin chào", weight: 4 },
      { term: "chào", weight: 3 },
      { term: "hello", weight: 4 },
      { term: "hi", weight: 2 },
      { term: "cảm ơn", weight: 3 },
      { term: "tạm biệt", weight: 3 },
      { term: "bạn là ai", weight: 3 },
      { term: "ok", weight: 1 },
    ],
  },
];

const PRODUCT_ALIASES = ["airbeat", "tai nghe", "keynova", "bàn phím", "volt", "sạc", "abp-01", "kn-75", "v65"];

const CONFIDENCE_THRESHOLD = 0.55;

/** Lowercase + strip Vietnamese diacritics so "hoan tien" also matches. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function matches(haystack: string, term: string): boolean {
  const folded = fold(term);
  if (folded.length <= 3) {
    return new RegExp(`(^|[^a-z0-9])${folded}([^a-z0-9]|$)`, "i").test(haystack);
  }
  return haystack.includes(folded);
}

export function routeMessage(message: string, memory: MemorySnapshot): RouteDecision {
  const folded = fold(message);
  const candidates: RouteCandidate[] = [];
  const rationales: string[] = [];

  for (const rule of RULES) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (matches(folded, keyword.term)) score += keyword.weight;
    }
    if (score > 0) candidates.push({ intent: rule.intent, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];

  const explicitId =
    message.match(/#(\d{4,6})\b/)?.[1] ?? message.match(/(?<!\d)(\d{4,6})(?!\d)/)?.[1];
  const productAlias = PRODUCT_ALIASES.find((alias) => folded.includes(alias));
  const productTerm = productAlias ?? (top?.intent === "product" ? message : undefined);

  if (!top) {
    rationales.push("Không khớp từ khoá của intent nào → cần hỏi lại hoặc chuyển nhân viên.");
    return {
      intent: "unknown",
      confidence: 0,
      candidates: [],
      orderId: explicitId,
      productTerm,
      resolvedFromMemory: false,
      rationale: rationales,
      engine: "rules",
    };
  }

  const secondScore = candidates[1]?.score ?? 0;
  const confidence = Math.min(
    0.97,
    Math.round((0.5 + 0.035 * top.score + 0.03 * (top.score - secondScore)) * 100) / 100,
  );

  const matched = RULES.find((rule) => rule.intent === top.intent)!.keywords
    .filter((keyword) => matches(folded, keyword.term))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3);
  for (const keyword of matched) {
    rationales.push(`Khớp cụm “${keyword.term}” (+${keyword.weight})`);
  }
  if (candidates[1]) {
    rationales.push(
      `Intent xếp sau: ${candidates[1].intent} (${candidates[1].score} điểm) — độ lệch tạo tin cậy.`,
    );
  }
  const intent = confidence >= CONFIDENCE_THRESHOLD ? top.intent : "unknown";
  if (intent === "unknown") {
    rationales.push(
      `Tin cậy ${(confidence * 100).toFixed(0)}% < ngưỡng ${CONFIDENCE_THRESHOLD * 100}% → fallback.`,
    );
  }

  // Order slot from memory only makes sense for order-related intents.
  const wantsOrder = intent === "order_status" || intent === "refund";
  let orderId = explicitId;
  let resolvedFromMemory = false;
  if (!orderId && wantsOrder && memory.slots.orderId) {
    orderId = memory.slots.orderId;
    resolvedFromMemory = true;
  }

  if (explicitId && wantsOrder) rationales.push(`Trích được mã đơn #${explicitId} từ câu hỏi.`);
  else if (resolvedFromMemory && memory.slots.orderId) {
    rationales.push(`Không có mã đơn trong câu → dùng #${memory.slots.orderId} từ ngữ cảnh hội thoại.`);
  }

  return {
    intent,
    confidence,
    candidates: candidates.slice(0, 3),
    orderId,
    productTerm,
    resolvedFromMemory,
    rationale: rationales,
    engine: "rules",
  };
}

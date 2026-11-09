import type { Order } from "./catalog";
import { formatVnd } from "./utils";
import type { Citation, MemorySnapshot, PlanStepView, RouteDecision, StepResult } from "./types";

interface EligibilityOutput {
  eligible: boolean;
  reason: string;
  amount: number;
  policyId: string;
}
interface TrackingOutput {
  carrier: string;
  tracking: string;
  eta: string;
  checkpoint: string;
}
interface PolicyOutput {
  id: string;
  title: string;
  body: string;
}
interface SearchItem {
  sku: string;
  name: string;
  price: number;
  stock: number;
  warehouse: string;
  warrantyMonths: number;
}
interface SearchOutput {
  mode?: "single" | "list";
  sku?: string;
  name?: string;
  price?: number;
  warrantyMonths?: number;
  count?: number;
  items?: SearchItem[];
}
interface StockOutput {
  sku: string;
  stock: number;
  warehouse: string;
  restockEta?: string;
}
interface TicketOutput {
  id: string;
  priority: string;
  subject: string;
  slaHours: number;
}

export interface ComposeStep {
  view: PlanStepView;
  result: StepResult;
}

export interface ComposeInput {
  message: string;
  decision: RouteDecision;
  steps: ComposeStep[];
  outputs: Record<string, unknown>;
  memory: MemorySnapshot;
}

export interface ComposeOutput {
  text: string;
  chunks: string[];
  citations: Citation[];
  suggestions: string[];
  degraded: boolean;
  note: string;
}

const STATUS_LABEL: Record<Order["status"], string> = {
  processing: "đang xử lý",
  shipping: "đang vận chuyển",
  delivered: "đã giao",
  refund_pending: "đang chờ hoàn tiền",
};

const DEFAULT_SUGGESTIONS = [
  "Đơn #1002 tới đâu rồi?",
  "Hoàn tiền đơn 1004",
  "Tai nghe AirBeat còn hàng không?",
];

function err(step: ComposeStep | undefined): string | undefined {
  return step?.result.status === "error" ? step.result.error : undefined;
}

/**
 * Template composer must not depend on step ids: the rules planner uses
 * "lookup", an LLM may use "s1" or "order_lookup". Resolve by tool name.
 */
function outputOf<T>(input: ComposeInput, tool: string, fallbackKey: string): T | undefined {
  const step = input.steps.find((item) => item.view.tool === tool);
  if (step?.result.status === "ok") return step.result.output as T;
  return input.outputs[fallbackKey] as T | undefined;
}

export function chunkText(text: string, wordsPerChunk = 4): string[] {
  const words = text.match(/\s*\S+/g) ?? [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(""));
  }
  return chunks;
}

/**
 * Deterministic "LLM-free" composer: it may only rephrase values that came
 * out of tools. That is the grounding rule a real answer model must follow.
 */
export function compose(input: ComposeInput): ComposeOutput {
  const { decision, steps, memory, message } = input;
  const stepOf = (tool: string) => steps.find((step) => step.view.tool === tool);
  const citations: Citation[] = [];
  let suggestions = DEFAULT_SUGGESTIONS;
  const degraded = steps.some((step) => step.result.status === "error");

  const order = outputOf<Order>(input, "order.lookup", "lookup");
  const eligibility = outputOf<EligibilityOutput>(input, "refund.check", "eligibility");
  const tracking = outputOf<TrackingOutput>(input, "shipping.track", "tracking");
  const policy = outputOf<PolicyOutput>(input, "policy.search", "policy");
  const search = outputOf<SearchOutput>(input, "product.search", "search");
  const stock = outputOf<StockOutput>(input, "inventory.check", "stock");
  const ticket = outputOf<TicketOutput>(input, "ticket.create", "ticket");

  const policyStep = steps.find((step) => step.view.tool === "policy.search");
  if (policyStep?.result.status === "ok" && policy) {
    citations.push({ title: policy.title, source: `KB #${policy.id}` });
  }

  let text = "";
  const note =
    "Composer chỉ dùng dữ liệu tool trả về + template. Không có dữ kiện nào được sinh thêm (grounding).";

  switch (decision.intent) {
    case "order_status": {
      if (!decision.orderId) {
        text = [
          "Mình cần mã đơn hàng để kiểm tra (ví dụ #1002).",
          "",
          "Nếu chưa nhớ mã đơn, bạn cho mình biết email đã đặt hàng nhé.",
        ].join("\n");
        suggestions = ["Đơn #1002 tới đâu rồi?", "Đơn #1004 tới đâu rồi?"];
        break;
      }
      if (!order) {
        text = [
          `Mình không tra được đơn #${decision.orderId ?? "?"}.`,
          err(stepOf("order.lookup")) ?? "Bạn kiểm tra lại mã đơn giúp mình nhé.",
          "",
          "Bạn có thể thử lại với mã khác, hoặc mình chuyển bạn tới nhân viên.",
        ].join("\n");
        suggestions = ["Đơn #1002 tới đâu rồi?", "Gặp nhân viên"];
        break;
      }
      citations.push({ title: `Đơn #${order.id}`, source: "OMS" });
      const lines = [
        `Đơn #${order.id} hiện ${STATUS_LABEL[order.status]}.`,
        "",
        ...order.items.map(
          (item) => `• ${item.name} ×${item.qty} — ${formatVnd(item.price * item.qty)}`,
        ),
        `• Đặt ngày: ${order.placedAt}`,
      ];
      if (tracking) {
        lines.push(
          `• Vận chuyển: ${tracking.carrier} (${tracking.tracking}) — ${tracking.checkpoint}`,
          `• Dự kiến tới: ${tracking.eta}`,
        );
      } else if (order.status === "shipping" || order.status === "delivered") {
        lines.push(
          `• Vận chuyển: chưa lấy được dữ liệu (${err(stepOf("shipping.track")) ?? "tool lỗi"}).`,
        );
      }
      if (order.status === "delivered" && tracking) {
        lines.push("", "Bạn cần hỗ trợ bảo hành hoặc đổi trả thì nói mình nhé.");
      }
      text = lines.join("\n");
      suggestions = ["Tôi muốn hoàn tiền đơn này", "Chính sách bảo hành", "Gặp nhân viên"];
      break;
    }

    case "refund": {
      if (!decision.orderId) {
        text = [
          "Mình cần mã đơn hàng để kiểm tra điều kiện hoàn tiền (ví dụ #1004).",
          "",
          "Bạn cho mình mã đơn muốn hoàn tiền nhé.",
        ].join("\n");
        suggestions = ["Hoàn tiền đơn 1004", "Hoàn tiền đơn 1001"];
        break;
      }
      if (!order) {
        text = [
          `Mình không tra được đơn #${decision.orderId ?? "?"}.`,
          err(stepOf("order.lookup")) ?? "Bạn kiểm tra lại mã đơn giúp mình nhé.",
          "",
          "Hoặc mình chuyển bạn tới nhân viên để kiểm tra thủ công.",
        ].join("\n");
        suggestions = ["Hoàn tiền đơn 1004", "Gặp nhân viên"];
        break;
      }
      citations.push({ title: `Đơn #${order.id}`, source: "OMS" });
      if (!eligibility) {
        text = [
          `Mình chưa kiểm tra được điều kiện hoàn tiền cho đơn #${order.id}.`,
          err(stepOf("refund.check")) ?? "Bộ kiểm tra điều kiện đang lỗi.",
          "",
          policy ? `Theo ${policy.title}: ${policy.body}` : "",
          "Bạn thử lại sau ít phút, hoặc mình chuyển nhân viên xử lý ngay.",
        ]
          .filter(Boolean)
          .join("\n");
        suggestions = ["Gặp nhân viên", "Chính sách hoàn tiền"];
        break;
      }
      if (eligibility.eligible) {
        const lines = [
          `Đơn #${order.id} đủ điều kiện hoàn tiền.`,
          "",
          `• Lý do: ${eligibility.reason}`,
          `• Số tiền hoàn: ${formatVnd(eligibility.amount)}`,
          "• Thời gian xử lý: 3–5 ngày làm việc",
        ];
        if (ticket) {
          citations.push({ title: `Phiếu ${ticket.id}`, source: "CSKH" });
          lines.push(
            "",
            `Mình đã tạo phiếu ${ticket.id} (SLA ${ticket.slaHours}h) để bộ phận hoàn tiền xử lý.`,
          );
        }
        text = lines.join("\n");
        suggestions = ["Chính sách hoàn tiền", "Gặp nhân viên"];
      } else {
        text = [
          `Đơn #${order.id} chưa đủ điều kiện hoàn tiền.`,
          "",
          `• Lý do: ${eligibility.reason}`,
          policy ? `• Chính sách: ${policy.body}` : "",
          "",
          "Bạn có thể yêu cầu bảo hành, hoặc gặp nhân viên để xem xét ngoại lệ.",
        ]
          .filter(Boolean)
          .join("\n");
        suggestions = ["Chính sách bảo hành", "Gặp nhân viên"];
      }
      break;
    }

    case "product": {
      if (search?.mode === "list" && search.items) {
        const items = search.items;
        const inStock = items.filter((item) => item.stock > 0).length;
        text = [
          `Shop đang có ${items.length} sản phẩm (${inStock} còn hàng):`,
          "",
          ...items.map(
            (item) =>
              `• ${item.name} — ${formatVnd(item.price)} · ${
                item.stock > 0 ? `còn ${item.stock} (${item.warehouse})` : "hết hàng"
              } · BH ${item.warrantyMonths} tháng`,
          ),
          "",
          "Bạn muốn mình kiểm tra kỹ sản phẩm nào không?",
        ].join("\n");
        citations.push({ title: `Catalog: ${items.length} sản phẩm`, source: "PIM" });
        suggestions = items.slice(0, 3).map((item) => `${item.name} còn hàng không?`);
        break;
      }
      if (!search) {
        text = [
          `Mình chưa tìm thấy sản phẩm khớp với “${message.trim()}”.`,
          err(stepOf("product.search")) ?? "",
          "",
          "Bạn thử tên khác nhé: AirBeat Pro, KeyNova 75, Volt 65W. Hoặc hỏi “shop có những sản phẩm nào?”.",
        ]
          .filter(Boolean)
          .join("\n");
        suggestions = ["Shop có những sản phẩm nào?", "Tai nghe AirBeat còn hàng không?"];
        break;
      }
      const singleName = search.name ?? "Sản phẩm";
      const singleSku = search.sku ?? "—";
      citations.push({ title: singleName, source: `SKU ${singleSku}` });
      const lines = [
        `${singleName} (SKU ${singleSku}) — ${formatVnd(search.price ?? 0)}.`,
        "",
      ];
      if (stock) {
        if (stock.stock > 0) {
          lines.push(
            `• Còn ${stock.stock} chiếc tại ${stock.warehouse}`,
            `• Bảo hành ${search.warrantyMonths ?? 0} tháng`,
            "",
            "Bạn muốn mình giữ hàng hoặc báo thêm màu sắc không?",
          );
        } else {
          lines.push(
            `• Tạm hết hàng tại ${stock.warehouse}`,
            stock.restockEta ? `• Dự kiến về: ${stock.restockEta}` : "",
            "",
            "Bạn để lại thông tin, mình báo ngay khi có hàng nhé.",
          );
        }
      } else {
        lines.push(
          `• Chưa kiểm tra được tồn kho (${err(stepOf("inventory.check")) ?? "tool lỗi"}).`,
          "",
          "Bạn thử lại sau ít phút hoặc gặp nhân viên để kiểm tra thủ công.",
        );
      }
      text = lines.filter(Boolean).join("\n");
      suggestions =
        stock && stock.stock > 0
          ? ["Chính sách bảo hành", "Gặp nhân viên"]
          : ["Thông báo khi có hàng", "Gặp nhân viên"];
      break;
    }

    case "faq": {
      if (policy) {
        text = [`${policy.title}`, "", policy.body, "", `Nguồn: KB #${policy.id}`].join("\n");
        suggestions = ["Chính sách đổi trả", "Thời gian giao hàng", "Gặp nhân viên"];
      } else {
        text = [
          "Mình chưa tìm thấy chính sách phù hợp trong knowledge base.",
          err(stepOf("policy.search")) ?? "",
          "",
          "Bạn diễn đạt lại giúp mình, hoặc mình chuyển tới nhân viên nhé.",
        ]
          .filter(Boolean)
          .join("\n");
        suggestions = ["Chính sách đổi trả", "Gặp nhân viên"];
      }
      break;
    }

    case "human_handoff": {
      if (ticket) {
        citations.push({ title: `Phiếu ${ticket.id}`, source: "CSKH" });
        text = [
          `Đã tạo phiếu ${ticket.id} với ưu tiên ${ticket.priority}.`,
          "",
          `• Chủ đề: ${ticket.subject}`,
          `• Nhân viên phản hồi trong ${ticket.slaHours} giờ làm việc`,
          "",
          "Trong lúc chờ, bạn có thể để lại thêm thông tin ở đây.",
        ].join("\n");
      } else {
        text = [
          "Mình chưa tạo được phiếu hỗ trợ lúc này.",
          err(stepOf("ticket.create")) ?? "",
          "Bạn gọi hotline 1900 0000 để gặp nhân viên ngay nhé.",
        ]
          .filter(Boolean)
          .join("\n");
      }
      suggestions = ["Cảm ơn", "Kiểm tra đơn #1002"];
      break;
    }

    case "smalltalk": {
      const memoryLine = memory.slots.orderId
        ? ` Mình vẫn đang giữ ngữ cảnh đơn #${memory.slots.orderId}.`
        : "";
      if (/cảm ơn|thank/i.test(message)) {
        text = `Rất vui được hỗ trợ bạn.${memoryLine} Cần gì thêm cứ nhắn mình nhé.`;
      } else if (/tạm biệt|bye/i.test(message)) {
        text = "Hẹn gặp lại bạn. Chúc một ngày tốt lành!";
      } else {
        text = [
          "Chào bạn 👋 Mình là trợ lý demo của Orchestrator Playground.",
          memoryLine ? memoryLine.trim() : "",
          "Mình có thể kiểm tra đơn hàng, điều kiện hoàn tiền, tồn kho và chính sách. Bạn muốn thử gì trước?",
        ]
          .filter(Boolean)
          .join(" ");
        suggestions = DEFAULT_SUGGESTIONS;
      }
      break;
    }

    default: {
      text = [
        "Mình chưa xác định được ý định của bạn (độ tin cậy thấp).",
        "",
        "Bạn có thể hỏi về: đơn hàng, hoàn tiền, tồn kho, chính sách — hoặc mình chuyển tới nhân viên.",
      ].join("\n");
      suggestions = [...DEFAULT_SUGGESTIONS, "Gặp nhân viên"];
      break;
    }
  }

  if (degraded) {
    text = `${text}\n\n⚠️ Một bước tra cứu bị lỗi nên câu trả lời có thể thiếu thông tin. Bạn có thể thử lại hoặc gặp nhân viên.`;
    if (!suggestions.includes("Gặp nhân viên")) suggestions = [...suggestions, "Gặp nhân viên"];
  }

  return {
    text,
    chunks: chunkText(text),
    citations,
    suggestions,
    degraded,
    note,
  };
}

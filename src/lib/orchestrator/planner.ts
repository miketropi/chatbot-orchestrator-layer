import { wantsCatalogListing } from "./tools";
import type { PlanStepView, RouteDecision } from "./types";

export interface PlanStep extends PlanStepView {
  resolveArgs: (outputs: Record<string, unknown>) => Record<string, unknown>;
  when?: (outputs: Record<string, unknown>) => boolean;
  /** Args that must be defined after placeholder resolution. */
  requiredArgs?: string[];
}

export interface Plan {
  steps: PlanStep[];
  note: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Intent → DAG. Edges are data dependencies, not a fixed sequence: the
 * executor is free to run independent steps concurrently (see engine.ts).
 *
 * Seam for a real system: same output shape, but produced by an LLM planner
 * constrained to a tool schema (function calling), plus validation against
 * the tool registry before execution.
 */
export function buildPlan(decision: RouteDecision, message: string): Plan {
  const orderId = decision.orderId;

  switch (decision.intent) {
    case "order_status": {
      if (!orderId) {
        return {
          steps: [],
          note: "Thiếu slot bắt buộc (mã đơn) → orchestrator không gọi tool mà hỏi lại người dùng.",
        };
      }
      return {
        steps: [
          {
            id: "lookup",
            label: "Tra đơn hàng",
            tool: "order.lookup",
            dependsOn: [],
            critical: true,
            note: "Bước gốc: mọi thông tin khác đều suy ra từ đơn này.",
            args: { orderId },
            resolveArgs: () => ({ orderId }),
          },
          {
            id: "policy",
            label: "Tra chính sách giao hàng",
            tool: "policy.search",
            dependsOn: [],
            critical: false,
            note: "Không phụ thuộc bước nào → chạy song song với bước tra đơn.",
            args: { query: "thời gian giao hàng" },
            resolveArgs: () => ({ query: "thời gian giao hàng" }),
          },
          {
            id: "tracking",
            label: "Tra vận chuyển",
            tool: "shipping.track",
            dependsOn: ["lookup"],
            critical: true,
            note: "Cần mã đơn từ bước lookup → phải xếp sau (cạnh phụ thuộc).",
            args: { orderId },
            resolveArgs: () => ({ orderId }),
          },
        ],
        note: "2 bước độc lập chạy song song (lượt 1), bước tracking phụ thuộc lookup (lượt 2).",
      };
    }

    case "refund": {
      if (!orderId) {
        return {
          steps: [],
          note: "Thiếu mã đơn để kiểm tra điều kiện hoàn tiền → hỏi lại trước khi chạy tool.",
        };
      }
      return {
        steps: [
          {
            id: "lookup",
            label: "Tra đơn hàng",
            tool: "order.lookup",
            dependsOn: [],
            critical: true,
            note: "Cần trạng thái và ngày giao để rule engine hoàn tiền có dữ liệu.",
            args: { orderId },
            resolveArgs: () => ({ orderId }),
          },
          {
            id: "policy",
            label: "Tra chính sách hoàn tiền",
            tool: "policy.search",
            dependsOn: [],
            critical: false,
            note: "Độc lập với đơn → chạy song song, đồng thời cung cấp trích dẫn cho câu trả lời.",
            args: { query: "hoàn tiền" },
            resolveArgs: () => ({ query: "hoàn tiền" }),
          },
          {
            id: "eligibility",
            label: "Kiểm tra điều kiện hoàn tiền",
            tool: "refund.check",
            dependsOn: ["lookup"],
            critical: true,
            note: "Rule engine cần dữ liệu đơn hợp lệ trước khi kết luận.",
            args: { orderId },
            resolveArgs: () => ({ orderId }),
          },
          {
            id: "ticket",
            label: "Tạo phiếu hoàn tiền",
            tool: "ticket.create",
            dependsOn: ["eligibility"],
            critical: false,
            condition: "chỉ chạy khi eligibility.eligible = true",
            note: "Cạnh có điều kiện: kế hoạch khai báo tiềm năng, executor quyết định lúc chạy.",
            args: { subject: `Hoàn tiền đơn #${orderId}`, priority: "normal" },
            resolveArgs: () => ({
              subject: `Hoàn tiền đơn #${orderId}`,
              priority: "normal",
              summary: `Khách yêu cầu hoàn tiền đơn #${orderId}`,
            }),
            when: (outputs) => asRecord(outputs.eligibility).eligible === true,
          },
        ],
        note: "Lookup + policy chạy song song; eligibility phụ thuộc lookup; ticket là bước có điều kiện.",
      };
    }

    case "product": {
      if (wantsCatalogListing(message)) {
        return {
          steps: [
            {
              id: "search",
              label: "Liệt kê catalog",
              tool: "product.search",
              dependsOn: [],
              critical: true,
              note: "term=\"*\" bật chế độ liệt kê của tool (một call, không N+1).",
              args: { term: "*" },
              resolveArgs: () => ({ term: "*" }),
            },
          ],
          note: "Câu hỏi liệt kê → một bước lấy toàn bộ catalog, không cần inventory.check từng SKU.",
        };
      }
      return {
        steps: [
          {
            id: "search",
            label: "Tìm sản phẩm",
            tool: "product.search",
            dependsOn: [],
            critical: true,
            note: "Cần SKU trước khi hỏi kho → bước gốc của nhánh này.",
            args: { term: decision.productTerm ?? message },
            resolveArgs: () => ({ term: decision.productTerm ?? message }),
          },
          {
            id: "policy",
            label: "Tra chính sách bảo hành",
            tool: "policy.search",
            dependsOn: [],
            critical: false,
            note: "Độc lập → chạy song song với bước tìm sản phẩm.",
            args: { query: "bảo hành" },
            resolveArgs: () => ({ query: "bảo hành" }),
          },
          {
            id: "stock",
            label: "Kiểm tra tồn kho",
            tool: "inventory.check",
            dependsOn: ["search"],
            critical: true,
            note: "SKU được truyền từ output của bước search (data flow giữa các bước).",
            args: { sku: "{{search.sku}}" },
            resolveArgs: (outputs) => ({ sku: asRecord(outputs.search).sku ?? "" }),
          },
        ],
        note: "search + policy chạy song song; stock phụ thuộc SKU từ search.",
      };
    }

    case "faq": {
      return {
        steps: [
          {
            id: "policy",
            label: "Tra cứu chính sách",
            tool: "policy.search",
            dependsOn: [],
            critical: true,
            note: "Câu hỏi kiến thức → chỉ cần một tool tra knowledge base.",
            args: { query: message },
            resolveArgs: () => ({ query: message }),
          },
        ],
        note: "Kế hoạch tối giản: một tool, không phụ thuộc.",
      };
    }

    case "human_handoff": {
      return {
        steps: [
          {
            id: "ticket",
            label: "Tạo phiếu hỗ trợ",
            tool: "ticket.create",
            dependsOn: [],
            critical: true,
            note: "Handoff có side effect: ghi phiếu thật vào hệ thống CSKH.",
            args: { subject: "Yêu cầu gặp nhân viên", priority: "high" },
            resolveArgs: () => ({
              subject: "Yêu cầu gặp nhân viên",
              priority: "high",
              summary: message,
            }),
          },
        ],
        note: "Một bước ghi dữ liệu, ưu tiên cao.",
      };
    }

    default:
      return { steps: [], note: "Không có intent rõ ràng → không gọi tool, composer hỏi lại." };
  }
}

export function toViews(steps: PlanStep[]): PlanStepView[] {
  return steps.map(({ id, label, tool, dependsOn, critical, condition, note, args }) => ({
    id,
    label,
    tool,
    dependsOn,
    critical,
    condition,
    note,
    args,
  }));
}

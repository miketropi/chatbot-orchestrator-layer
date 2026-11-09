import type { FaultMode, Intent } from "@/lib/orchestrator/types";

export const INTENT_LABELS: Record<Intent, string> = {
  order_status: "Kiểm tra đơn hàng",
  refund: "Hoàn tiền / đổi trả",
  product: "Sản phẩm / tồn kho",
  faq: "Hỏi chính sách",
  human_handoff: "Chuyển nhân viên",
  smalltalk: "Chào hỏi",
  unknown: "Không xác định",
};

export const QUICK_PROMPTS = [
  "Đơn #1002 tới đâu rồi?",
  "Hoàn tiền đơn 1004",
  "Tai nghe AirBeat còn hàng không?",
  "Chính sách đổi trả thế nào?",
  "Cho mình gặp nhân viên",
];

export const FAULT_OPTIONS: { value: FaultMode; label: string; hint: string }[] = [
  { value: "none", label: "Bình thường", hint: "Mọi tool trả về bình thường." },
  {
    value: "retry",
    label: "Tool lỗi tạm thời",
    hint: "Lần gọi đầu của tool mục tiêu timeout → retry → thành công.",
  },
  {
    value: "down",
    label: "Tool chết hẳn",
    hint: "Mọi lần gọi tool mục tiêu đều lỗi → quan sát fallback + câu trả lời suy giảm.",
  },
];

export const FAULT_TARGETS: { intent: Intent; tool: string }[] = [
  { intent: "order_status", tool: "shipping.track" },
  { intent: "refund", tool: "refund.check" },
  { intent: "product", tool: "inventory.check" },
  { intent: "faq", tool: "policy.search" },
  { intent: "human_handoff", tool: "ticket.create" },
];

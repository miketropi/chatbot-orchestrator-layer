import { ORDERS, POLICIES, PRODUCTS } from "./catalog";
import { pseudoLatency, sleep } from "./utils";

export class ToolError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ToolError";
    this.retryable = retryable;
  }
}

export interface ToolContext {
  sessionId: string;
}

export interface ToolDef {
  name: string;
  label: string;
  description: string;
  timeoutMs: number;
  maxAttempts: number;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

function latency(tool: string, args: Record<string, unknown>, min = 140, max = 380) {
  return sleep(pseudoLatency(`${tool}:${JSON.stringify(args)}`, min, max));
}

function loadOrder(orderId: unknown) {
  const id = String(orderId ?? "").replace(/^#/, "").trim();
  const order = ORDERS[id];
  if (!order) throw new ToolError(`Không tìm thấy đơn #${id} trong hệ thống.`, false);
  return order;
}

function findPolicy(query: string) {
  const normalized = query.toLowerCase();
  let best: { policy: (typeof POLICIES)[number]; score: number } | null = null;
  for (const policy of POLICIES) {
    let score = 0;
    for (const tag of policy.tags) {
      if (normalized.includes(tag)) score += 4;
    }
    for (const word of normalized.split(/[\s,.;:!?]+/)) {
      if (word.length < 2) continue;
      if (policy.title.toLowerCase().includes(word)) score += 1;
      if (policy.body.toLowerCase().includes(word)) score += 0.5;
    }
    if (!best || score > best.score) best = { policy, score };
  }
  if (!best || best.score < 1) {
    throw new ToolError(`Không có chính sách nào khớp với "${query}".`, false);
  }
  return best.policy;
}

/** Query terms that mean "show me everything" rather than one product. */
const LIST_ALL = /^(|\*|all|tat ca|tất cả|toan bo|toàn bộ|danh sach|danh sách|list|any|-|…|\.\.\.)$/i;

/** One predicate shared by router, planner and tool so they never disagree. */
export function wantsCatalogListing(text: string): boolean {
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
  const listingCue =
    /\b(nhung|danh sach|liet ke|tat ca|toan bo|list|all|co gi|ban gi|co nhung gi)\b/.test(normalized);
  const productCue = /\b(san pham|mat hang|hang|product|shop)\b/.test(normalized);
  return listingCue && productCue;
}

export function isListAllQuery(term: string): boolean {
  const normalized = term
    .toLowerCase()
    .replace(/[?!.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (LIST_ALL.test(normalized)) return true;
  // "tất cả sản phẩm", "danh sách sản phẩm trong shop", "all products"
  return /\b(tat ca|tất cả|toan bo|toàn bộ|danh sach|danh sách|list all|all)\b.*\b(san pham|sản phẩm|product|hang|hàng)\b/.test(
    normalized,
  );
}

function findProduct(term: string) {
  const normalized = term.toLowerCase();
  // Only meaningful tokens: "*", "?", "sản phẩm" alone must not match.
  const tokens = normalized
    .split(/[^a-z0-9àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]+/i)
    .filter((token) => token.length > 1);
  let best: { product: (typeof PRODUCTS)[number]; score: number } | null = null;
  for (const product of PRODUCTS) {
    let score = 0;
    if (normalized.includes(product.sku.toLowerCase())) score += 6;
    if (normalized.includes(product.name.toLowerCase())) score += 6;
    for (const alias of product.aliases) {
      if (normalized.includes(alias)) score += 4;
    }
    for (const token of tokens) {
      if (product.name.toLowerCase().includes(token)) score += 2;
    }
    if (!best || score > best.score) best = { product, score };
  }
  if (!best || best.score < 4) {
    throw new ToolError(
      `Không tìm thấy sản phẩm khớp với "${term}". ` +
        `Dùng term="*" để liệt kê toàn bộ catalog (${PRODUCTS.length} sản phẩm).`,
      false,
    );
  }
  return best.product;
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = (value * 33 + text.charCodeAt(i)) | 0;
  return Math.abs(value);
}

export const TOOLS: Record<string, ToolDef> = {
  "order.lookup": {
    name: "order.lookup",
    label: "Tra đơn hàng",
    description: "Đọc trạng thái, mặt hàng và tổng tiền của một đơn trong OMS.",
    timeoutMs: 1500,
    maxAttempts: 2,
    async run(args) {
      await latency("order.lookup", args);
      return loadOrder(args.orderId);
    },
  },
  "shipping.track": {
    name: "shipping.track",
    label: "Tra vận chuyển",
    description: "Hỏi đơn vị vận chuyển về checkpoint mới nhất và ETA.",
    timeoutMs: 2000,
    maxAttempts: 3,
    async run(args) {
      await latency("shipping.track", args, 260, 620);
      const order = loadOrder(args.orderId);
      if (!order.carrier) {
        throw new ToolError("Đơn chưa bàn giao cho đơn vị vận chuyển.", false);
      }
      return {
        carrier: order.carrier,
        tracking: order.tracking,
        eta: order.eta ?? order.deliveredAt ?? "—",
        checkpoint:
          order.status === "shipping"
            ? "Đã rời kho phân loại HCM, đang tới kho giao."
            : order.status === "delivered"
              ? `Đã giao ngày ${order.deliveredAt}.`
              : "Chưa có checkpoint.",
      };
    },
  },
  "refund.check": {
    name: "refund.check",
    label: "Kiểm tra điều kiện hoàn tiền",
    description: "Chạy rule engine hoàn tiền dựa trên trạng thái đơn và thời gian.",
    timeoutMs: 1500,
    maxAttempts: 2,
    async run(args) {
      await latency("refund.check", args);
      const order = loadOrder(args.orderId);
      return {
        eligible: order.refundEligible,
        reason: order.refundReason,
        amount: order.refundEligible ? order.total : 0,
        policyId: "refund-policy",
      };
    },
  },
  "policy.search": {
    name: "policy.search",
    label: "Tra cứu chính sách",
    description: "Tìm đoạn chính sách liên quan trong knowledge base nội bộ.",
    timeoutMs: 1200,
    maxAttempts: 2,
    async run(args) {
      await latency("policy.search", args, 160, 340);
      const policy = findPolicy(String(args.query ?? ""));
      return {
        id: policy.id,
        title: policy.title,
        body: policy.body,
      };
    },
  },
  "product.search": {
    name: "product.search",
    label: "Tìm sản phẩm",
    description:
      "Tìm MỘT sản phẩm theo tên/SKU/từ khoá. Để liệt kê toàn bộ catalog, truyền term=\"*\".",
    timeoutMs: 1200,
    maxAttempts: 2,
    async run(args) {
      await latency("product.search", args);
      const term = String(args.term ?? "");

      if (isListAllQuery(term)) {
        return {
          mode: "list",
          count: PRODUCTS.length,
          items: PRODUCTS.map((product) => ({
            sku: product.sku,
            name: product.name,
            price: product.price,
            stock: product.stock,
            warehouse: product.warehouse,
            warrantyMonths: product.warrantyMonths,
          })),
        };
      }

      const product = findProduct(term);
      return {
        mode: "single",
        sku: product.sku,
        name: product.name,
        price: product.price,
        warrantyMonths: product.warrantyMonths,
      };
    },
  },
  "inventory.check": {
    name: "inventory.check",
    label: "Kiểm tra tồn kho",
    description: "Đọc số lượng khả dụng theo SKU từ hệ thống kho.",
    timeoutMs: 1200,
    maxAttempts: 2,
    async run(args) {
      await latency("inventory.check", args);
      const sku = String(args.sku ?? "");
      const product = PRODUCTS.find((item) => item.sku === sku);
      if (!product) throw new ToolError(`SKU ${sku} không tồn tại.`, false);
      return {
        sku: product.sku,
        stock: product.stock,
        warehouse: product.warehouse,
        restockEta: product.stock === 0 ? "20/11" : undefined,
      };
    },
  },
  "ticket.create": {
    name: "ticket.create",
    label: "Tạo phiếu hỗ trợ",
    description: "Ghi phiếu vào hệ thống CSKH để nhân viên tiếp nhận.",
    timeoutMs: 1500,
    maxAttempts: 2,
    async run(args, ctx) {
      await latency("ticket.create", args, 180, 320);
      const id = `TKT-${(hash(`${ctx.sessionId}:${args.subject}:${args.summary}`) % 9000) + 1000}`;
      return {
        id,
        priority: args.priority ?? "normal",
        subject: args.subject,
        slaHours: args.priority === "high" ? 2 : 8,
      };
    },
  },
};

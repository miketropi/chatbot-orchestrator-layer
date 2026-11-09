export interface OrderItem {
  name: string;
  qty: number;
  price: number;
}

export interface Order {
  id: string;
  status: "processing" | "shipping" | "delivered" | "refund_pending";
  items: OrderItem[];
  total: number;
  placedAt: string;
  deliveredAt?: string;
  carrier?: string;
  tracking?: string;
  eta?: string;
  refundEligible: boolean;
  refundReason: string;
}

export const ORDERS: Record<string, Order> = {
  "1001": {
    id: "1001",
    status: "delivered",
    items: [{ name: "Tai nghe AirBeat Pro", qty: 1, price: 1290000 }],
    total: 1290000,
    placedAt: "01/11",
    deliveredAt: "02/11",
    carrier: "GHN",
    tracking: "GHN-99213",
    refundEligible: false,
    refundReason: "Đã quá 7 ngày kể từ khi nhận hàng và sản phẩm đã bóc seal.",
  },
  "1002": {
    id: "1002",
    status: "shipping",
    items: [{ name: "Bàn phím KeyNova 75", qty: 1, price: 1650000 }],
    total: 1650000,
    placedAt: "07/11",
    carrier: "Viettel Post",
    tracking: "VTP-44120",
    eta: "12/11",
    refundEligible: false,
    refundReason: "Đơn đang vận chuyển — cần nhận hàng trước khi yêu cầu hoàn tiền.",
  },
  "1003": {
    id: "1003",
    status: "processing",
    items: [{ name: "Sạc nhanh Volt 65W", qty: 2, price: 345000 }],
    total: 690000,
    placedAt: "09/11",
    refundEligible: true,
    refundReason: "Chưa giao, có thể huỷ và hoàn tiền toàn bộ.",
  },
  "1004": {
    id: "1004",
    status: "delivered",
    items: [{ name: "Tai nghe AirBeat Pro", qty: 1, price: 1290000 }],
    total: 1290000,
    placedAt: "05/11",
    deliveredAt: "06/11",
    carrier: "GHN",
    tracking: "GHN-88117",
    refundEligible: true,
    refundReason: "Trong 7 ngày, còn nguyên seal và đủ phụ kiện.",
  },
};

export interface Product {
  sku: string;
  name: string;
  price: number;
  stock: number;
  warehouse: string;
  warrantyMonths: number;
  aliases: string[];
}

export const PRODUCTS: Product[] = [
  {
    sku: "ABP-01",
    name: "Tai nghe AirBeat Pro",
    price: 1290000,
    stock: 12,
    warehouse: "Kho HCM",
    warrantyMonths: 12,
    aliases: ["airbeat", "tai nghe", "headphone", "abp"],
  },
  {
    sku: "KN-75",
    name: "Bàn phím KeyNova 75",
    price: 1650000,
    stock: 0,
    warehouse: "Kho HCM",
    warrantyMonths: 24,
    aliases: ["keynova", "bàn phím", "keyboard", "kn75"],
  },
  {
    sku: "V65",
    name: "Sạc nhanh Volt 65W",
    price: 345000,
    stock: 3,
    warehouse: "Kho Hà Nội",
    warrantyMonths: 6,
    aliases: ["volt", "sạc", "charger", "65w"],
  },
  {
    sku: "MP-01",
    name: "Chuột không dây Glide S",
    price: 590000,
    stock: 24,
    warehouse: "Kho HCM",
    warrantyMonths: 12,
    aliases: ["glide", "chuột", "mouse"],
  },
  {
    sku: "HB-02",
    name: "Hub USB-C Nova 7in1",
    price: 720000,
    stock: 0,
    warehouse: "Kho Hà Nội",
    warrantyMonths: 12,
    aliases: ["hub", "nova", "usb-c"],
  },
];

export interface Policy {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

export const POLICIES: Policy[] = [
  {
    id: "refund-policy",
    title: "Chính sách đổi trả & hoàn tiền",
    body: "Sản phẩm được hoàn tiền trong 7 ngày kể từ khi nhận nếu còn nguyên seal và đầy đủ phụ kiện. Đơn đã bóc seal chỉ được hỗ trợ bảo hành. Thời gian hoàn tiền 3–5 ngày làm việc qua phương thức thanh toán ban đầu.",
    tags: ["hoàn tiền", "đổi trả", "trả hàng", "refund"],
  },
  {
    id: "shipping-policy",
    title: "Thời gian & phí giao hàng",
    body: "Nội thành TP.HCM giao trong 1–2 ngày, tỉnh thành khác 2–4 ngày làm việc. Miễn phí vận chuyển cho đơn từ 2.000.000₫. Đơn giao chậm quá 2 ngày so với dự kiến được ưu tiên khiếu nại với đơn vị vận chuyển.",
    tags: ["giao hàng", "vận chuyển", "ship", "phí giao"],
  },
  {
    id: "warranty-policy",
    title: "Chính sách bảo hành",
    body: "Bảo hành 12 tháng cho lỗi nhà sản xuất, 1 đổi 1 trong 30 ngày đầu nếu lỗi do nhà sản xuất. Không bảo hành rơi vỡ, vào nước hoặc tự tháo máy.",
    tags: ["bảo hành", "warranty", "lỗi", "đổi mới"],
  },
  {
    id: "payment-policy",
    title: "Thanh toán & hóa đơn",
    body: "Hỗ trợ COD, chuyển khoản, thẻ và trả góp 0% qua thẻ tín dụng 3–6 tháng. Hóa đơn điện tử gửi qua email trong 24 giờ sau khi giao thành công.",
    tags: ["thanh toán", "hóa đơn", "trả góp", "cod"],
  },
];

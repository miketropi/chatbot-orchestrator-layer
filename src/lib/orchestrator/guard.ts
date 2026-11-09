export interface GuardResult {
  allowed: boolean;
  reason: string;
}

const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?(the\s+)?(previous|above|prior)\s+instructions?/i, label: "ignore-previous-instructions" },
  { pattern: /(system|developer)\s+prompt/i, label: "system-prompt-probe" },
  { pattern: /bỏ\s+qua\s+(mọi\s+|tất\s+cả\s+)?(hướng\s+dẫn|chỉ\s+dẫn|quy\s+tắc)/i, label: "bo-qua-huong-dan" },
  { pattern: /you\s+are\s+now\s+(a|an|dan)\b/i, label: "role-override" },
  { pattern: /jailbreak/i, label: "jailbreak" },
];

/**
 * Input guardrail. Runs before routing so no tool is ever called with
 * untrusted or abusive input.
 */
export function checkInput(message: string): GuardResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return { allowed: false, reason: "Tin nhắn rỗng." };
  }
  if (trimmed.length > 1500) {
    return { allowed: false, reason: `Tin nhắn quá dài (${trimmed.length}/1500 ký tự).` };
  }
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Phát hiện mẫu thử prompt injection: ${label}.` };
    }
  }
  return { allowed: true, reason: "Đầu vào hợp lệ." };
}

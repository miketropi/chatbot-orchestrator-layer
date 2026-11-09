import { runChat } from "@/lib/orchestrator/engine";
import type { FaultMode } from "@/lib/orchestrator/types";

export const dynamic = "force-dynamic";

const FAULTS: FaultMode[] = ["none", "retry", "down"];

export async function POST(request: Request) {
  let payload: { sessionId?: unknown; message?: unknown; fault?: unknown; useLlm?: unknown };
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId : "anonymous";
  const message = typeof payload.message === "string" ? payload.message : "";
  if (!message.trim()) {
    return Response.json({ error: "message is required." }, { status: 400 });
  }
  const fault = FAULTS.includes(payload.fault as FaultMode) ? (payload.fault as FaultMode) : "none";
  const useLlm = payload.useLlm !== false;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        for await (const event of runChat({ sessionId, message, fault, useLlm })) {
          send(event);
        }
      } catch (error) {
        send({
          type: "error",
          t: 0,
          message: error instanceof Error ? error.message : "Unexpected orchestrator error.",
          note: "Exception thoát khỏi engine — toàn bộ trace trước đó vẫn còn.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

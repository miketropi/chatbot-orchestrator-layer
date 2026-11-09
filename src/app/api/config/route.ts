import { llmStatus } from "@/lib/orchestrator/llm-stages";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(llmStatus(), { headers: { "Cache-Control": "no-store" } });
}

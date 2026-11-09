import { OrchestratorDemo } from "@/components/orchestrator-demo";

const PIPELINE = [
  { name: "Guard", detail: "chặn input xấu" },
  { name: "Route", detail: "intent + slot" },
  { name: "Plan", detail: "DAG tool" },
  { name: "Execute", detail: "song song + retry" },
  { name: "Compose", detail: "grounded answer" },
];

export default function Page() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl border border-emerald-400/30 bg-emerald-400/10 font-mono text-[13px] font-semibold text-emerald-300">
            OR
          </span>
          <div className="min-w-0">
            <h1 className="text-balance text-lg font-semibold tracking-tight sm:text-xl">
              Orchestrator Playground
            </h1>
            <p className="text-[13px] text-slate-400">
              Lớp điều phối của chatbot: quyết định <em className="not-italic text-slate-300">gọi gì</em>,{" "}
              <em className="not-italic text-slate-300">theo thứ tự nào</em>,{" "}
              <em className="not-italic text-slate-300">lỗi thì làm gì</em>.
            </p>
          </div>
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            {["Next.js 15 · App Router", "NDJSON stream", "rules ↔ 9router"].map((badge) => (
              <span
                key={badge}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-400"
              >
                {badge}
              </span>
            ))}
          </div>
        </div>

        <ol className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
          {PIPELINE.map((stage, index) => (
            <li key={stage.name} className="flex items-center gap-1.5">
              <span className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1">
                <span className="font-mono text-[10px] text-emerald-300/80">{index + 1}</span>
                <span className="font-medium text-slate-200">{stage.name}</span>
                <span className="hidden text-slate-500 sm:inline">· {stage.detail}</span>
              </span>
              {index < PIPELINE.length - 1 && <span className="text-slate-600">→</span>}
            </li>
          ))}
        </ol>
      </header>

      <OrchestratorDemo />

      <section className="grid gap-3 md:grid-cols-2">
        <details className="group rounded-xl border border-white/10 bg-white/[0.02] p-4" open>
          <summary className="cursor-pointer list-none text-sm font-medium text-slate-200">
            Demo này đang dạy điều gì?
            <span className="float-right font-mono text-[10px] text-slate-500 group-open:hidden">mở</span>
          </summary>
          <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-slate-400">
            <li>
              <span className="text-slate-200">Planner trả DAG, không phải list.</span> Hai tool độc lập chạy song
              song; tool cần output của bước khác xếp sau. Xem cột trace: 2 bước mở cùng lúc ở lượt 1.
            </li>
            <li>
              <span className="text-slate-200">Điều kiện nằm trong kế hoạch.</span> Với intent hoàn tiền, bước tạo
              phiếu chỉ chạy khi <code className="font-mono text-emerald-300">eligible = true</code>.
            </li>
            <li>
              <span className="text-slate-200">Lỗi là một phần của thiết kế.</span> Bật fault switch: tool lỗi tạm
              thời → retry; tool chết → câu trả lời suy giảm (degraded) + gợi ý chuyển nhân viên.
            </li>
            <li>
              <span className="text-slate-200">Memory là slot, không phải cả transcript.</span> Hỏi “Đơn #1002 tới
              đâu rồi?” rồi “Nó tới đâu rồi?” — router lấy mã đơn từ memory.
            </li>
            <li>
              <span className="text-slate-200">Composer không được bịa.</span> Mọi con số trong câu trả lời đều đến
              từ output tool; trace cho bạn kiểm chứng điều đó.
            </li>
          </ul>
        </details>

        <details className="group rounded-xl border border-white/10 bg-white/[0.02] p-4" open>
          <summary className="cursor-pointer list-none text-sm font-medium text-slate-200">
            Thay LLM thật vào đâu?
            <span className="float-right font-mono text-[10px] text-slate-500 group-open:hidden">mở</span>
          </summary>
          <div className="mt-3 space-y-2 text-[13px] leading-relaxed text-slate-400">
            <p>
              Đã nối sẵn qua <code className="font-mono text-slate-300">llm-stages.ts</code> (OpenAI-compatible, mặc
              định trỏ 9router). Ba seam giữ nguyên contract, chỉ đổi phần thân:
            </p>
            <ul className="space-y-1.5">
              <li>
                Router → JSON <code className="font-mono text-emerald-300">{`{intent, confidence, orderId}`}</code>,
                vẫn so ngưỡng 55%.
              </li>
              <li>
                Planner → model sinh <code className="font-mono text-emerald-300">steps[]</code>; server validate
                registry, thứ tự phụ thuộc, không vòng, điều kiện bị giới hạn cú pháp.
              </li>
              <li>
                Composer → model chỉ thấy <code className="font-mono text-emerald-300">TOOL_DATA</code> +{" "}
                <code className="font-mono text-emerald-300">FAILED_STEPS</code>; citation lấy từ tool, không từ model.
              </li>
            </ul>
            <p className="pt-1">
              Executor, retry, memory, guard và event trace dùng lại nguyên vẹn. Đó chính là giá trị của việc tách
              lớp orchestrator khỏi phần “gọi model”. Điền <code className="font-mono text-slate-300">.env.local</code>{" "}
              (xem <code className="font-mono text-slate-300">.env.example</code>) để bật LLM; lỗi/timeout tự fallback
              về rules và ghi warning vào trace.
            </p>
          </div>
        </details>
      </section>

      <footer className="pb-4 text-center text-[11px] text-slate-600">
        Dữ liệu đơn hàng/sản phẩm/chính sách là mock. Memory lưu in-process, reset khi restart hoặc bấm “Session
        mới”.
      </footer>
    </main>
  );
}

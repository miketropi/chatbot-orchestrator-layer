import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orchestrator Playground — Chatbot orchestration layer",
  description:
    "Demo mini Next.js: guard → route → plan → execute → compose, streaming trace và memory cho chatbot.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" className="dark">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}

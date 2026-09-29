/**
 * AI Gateway smoke test — Vercel AI SDK.
 *
 * Run:  npx tsx --env-file=.env.local index.ts
 * Requires AI_GATEWAY_API_KEY in .env.local (never committed).
 */

import { generateText, gateway } from "ai";

async function main() {
  const { text } = await generateText({
    model: gateway("openai/gpt-5.5"),
    prompt:
      "Invent a brand-new holiday. Give it a name, a date, and describe its traditions in a short, vivid paragraph.",
  });

  if (!text || text.trim().length === 0) {
    throw new Error("model returned empty text");
  }
  console.log("=== MODEL OUTPUT ===");
  console.log(text);
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});

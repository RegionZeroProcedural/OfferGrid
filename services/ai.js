import { getConfigValue } from "../lib/privateConfig.js";

function extractText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return "";
}

export async function enrichProductWithAI(product) {
  const apiKey = getConfigValue("OPENAI_API_KEY", "");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured in .env");

  const model = getConfigValue("OPENAI_MODEL", "gpt-5-mini");
  const payload = {
    title: product.title,
    brand: product.brand,
    currentCategory: product.category,
    offers: product.offers.slice(0, 5).map(o => ({
      merchant: o.merchant,
      price: o.price,
      currency: o.currency,
      provider: o.provider,
    })),
  };

  const instructions = [
    "You are editing an affiliate product catalog.",
    "Return ONLY valid JSON with keys category, summary, tags.",
    "category: short human-readable category.",
    "summary: 1-2 factual sentences explaining what the product is and who it may be useful for.",
    "tags: array of 3-8 short strings.",
    "Do not invent specs, reviews, discounts, medical claims, performance claims, or merchant facts.",
    "Do not call something the best unless the supplied facts prove it."
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${await response.text()}`);
  }

  const text = extractText(await response.json()).trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI response did not contain a JSON object.");

  const data = JSON.parse(match[0]);
  return {
    category: String(data.category || product.category || "Other").slice(0, 200),
    summary: String(data.summary || "").slice(0, 1800),
    tags: Array.isArray(data.tags) ? data.tags.map(v => String(v).slice(0, 80)).slice(0, 10) : [],
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  dashboardUrl: (process.env.DASHBOARD_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  llm: {
    model: process.env.LLM_MODEL ?? "claude-opus-5-5",
    effort: (process.env.LLM_EFFORT ?? "low") as "low" | "medium" | "high" | "xhigh" | "max",
    fallbacks: (process.env.LLM_FALLBACKS ?? "default") !== "off",
  },
  voyage: {
    apiKey: process.env.VOYAGE_API_KEY ?? "",
    model: process.env.VOYAGE_MODEL ?? "voyage-3.5",
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    prices: {
      starter: process.env.STRIPE_PRICE_STARTER ?? "",
      growth: process.env.STRIPE_PRICE_GROWTH ?? "",
      business: process.env.STRIPE_PRICE_BUSINESS ?? "",
    } as Record<string, string>,
  },
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
};

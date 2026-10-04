function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export const config = {
  production: process.env.NODE_ENV === "production",
  port: Number(process.env.PORT ?? 4000),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  dashboardUrl: (process.env.DASHBOARD_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  // 32-byte key (64 hex chars) used to encrypt secrets such as WhatsApp access tokens at rest.
  encryptionKey: process.env.APP_ENCRYPTION_KEY ?? "",
  llm: {
    model: process.env.LLM_MODEL ?? "claude-opus-5-5",
    effort: (process.env.LLM_EFFORT ?? "low") as "low" | "medium" | "high" | "xhigh" | "max",
  },
  voyage: {
    apiKey: process.env.VOYAGE_API_KEY ?? "",
    model: process.env.VOYAGE_MODEL ?? "voyage-3.5",
  },
  whatsapp: {
    // One Meta app for all of vanibot; each company's number has its own phone number ID and token (stored per bot).
    appSecret: process.env.WHATSAPP_APP_SECRET ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0",
    graphBase: (process.env.WHATSAPP_GRAPH_BASE ?? "https://graph.facebook.com").replace(/\/$/, ""),
  },
  speech: {
    provider: (process.env.SPEECH_PROVIDER ?? "sarvam") as "sarvam" | "none",
    sarvamApiKey: process.env.SARVAM_API_KEY ?? "",
    sarvamBase: (process.env.SARVAM_API_BASE ?? "https://api.sarvam.ai").replace(/\/$/, ""),
    sttModel: process.env.SARVAM_STT_MODEL ?? "",
    ttsModel: process.env.SARVAM_TTS_MODEL ?? "bulbul:v3",
    ttsSpeaker: process.env.SARVAM_TTS_SPEAKER ?? "",
  },
  // Phone calls (Twilio) are switched off until the phone phase.
  phone: {
    enabled: process.env.PHONE_ENABLED === "true",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  },
};

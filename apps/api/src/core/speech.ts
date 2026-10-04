import { config } from "../config.js";

// Speech-to-text and text-to-speech behind one small interface, so the provider can be swapped later
// (Sarvam AI today; Bhashini, Google or others can be added as another implementation).

export type Transcript = { text: string; language: string | null };
export type SpeechAudio = { data: Buffer; mimeType: string; filename: string };

export interface SpeechProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<Transcript>;
  synthesize(text: string, language: string, speaker?: string): Promise<SpeechAudio | null>;
}

export class SpeechUnavailableError extends Error {}

/** Languages Sarvam can speak. Anything else gets a text-only reply. */
export const TTS_LANGUAGES = new Set(["en-IN", "hi-IN", "bn-IN", "ta-IN", "te-IN", "mr-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN", "od-IN"]);

class SarvamSpeech implements SpeechProvider {
  readonly name = "sarvam";
  constructor(
    private apiKey: string,
    private base: string,
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<Transcript> {
    const form = new FormData();
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("amr") ? "amr" : "wav";
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType.split(";")[0] }), `voice.${ext}`);
    form.append("language_code", "unknown"); // auto-detect the language
    if (config.speech.sttModel) form.append("model", config.speech.sttModel);
    const res = await fetch(`${this.base}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": this.apiKey },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Sarvam speech-to-text failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { transcript?: string; language_code?: string | null };
    return { text: (json.transcript ?? "").trim(), language: json.language_code ?? null };
  }

  async synthesize(text: string, language: string, speaker?: string): Promise<SpeechAudio | null> {
    if (!TTS_LANGUAGES.has(language)) return null;
    const body: Record<string, unknown> = {
      text: text.slice(0, 2500),
      target_language_code: language,
      model: config.speech.ttsModel,
      output_audio_codec: "mp3", // WhatsApp accepts audio/mpeg
    };
    const voice = speaker || config.speech.ttsSpeaker;
    if (voice) body.speaker = voice.toLowerCase();
    const res = await fetch(`${this.base}/text-to-speech`, {
      method: "POST",
      headers: { "api-subscription-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Sarvam text-to-speech failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { audios?: string[] };
    if (!json.audios?.length) return null;
    return { data: Buffer.concat(json.audios.map((a) => Buffer.from(a, "base64"))), mimeType: "audio/mpeg", filename: "reply.mp3" };
  }
}

class NoSpeech implements SpeechProvider {
  readonly name = "none";
  async transcribe(): Promise<Transcript> {
    throw new SpeechUnavailableError("Voice notes are not configured (set SARVAM_API_KEY).");
  }
  async synthesize(): Promise<SpeechAudio | null> {
    return null;
  }
}

let override: SpeechProvider | null = null;

/** For tests: replace the speech provider. */
export function setSpeechProvider(p: SpeechProvider | null) {
  override = p;
}

export function speech(): SpeechProvider {
  if (override) return override;
  if (config.speech.provider === "sarvam" && config.speech.sarvamApiKey) return new SarvamSpeech(config.speech.sarvamApiKey, config.speech.sarvamBase);
  return new NoSpeech();
}

/** Turns a chat reply into something that sounds natural when spoken. */
export function textForSpeech(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`>~]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

import { GoogleGenAI, type Part } from "@google/genai";
import { z } from "zod";

// Gemini only ever returns DATA in a fixed schema. It never calls PayPal and never sets an amount;
// everything it returns is validated by zod and then checked by deterministic code.

// Two model lists, tried in order; the next one takes over whenever a model is overloaded (503), rate-limited (429) or times out.
const list = (env: string | undefined, fallback: string) => (env ?? fallback).split(",").map((m) => m.trim()).filter(Boolean);
/** Simple, fast jobs (column mapping, letter wording, "Ask the grid"): the least crowded model first. */
export const FAST_MODELS = list(process.env.GEMINI_FAST_MODELS, "gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.8-flash");
/** The policy compile, which must be right: the model that passed every check in testing first, lite only as a last resort. */
export const ACCURATE_MODELS = list(process.env.GEMINI_ACCURATE_MODELS, "gemini-3.5-flash,gemini-3.8-flash,gemini-3.1-flash-lite");
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 45_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isBusy = (err: unknown) =>
  /"code":\s*(429|500|503)|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|timed? ?out|abort/i.test(`${(err as Error)?.name ?? ""} ${(err as Error)?.message ?? err}`);

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  // A hard timeout: a hung request must fail fast so the next model gets a turn (observed: a call that never returned).
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: CALL_TIMEOUT_MS } });
  return client;
}

export type JsonCallResult<T> = { data: T; model: string; attempts: number };

/**
 * Ask Gemini for JSON matching `schema`. Validation failures are fed back so the model can fix them.
 * Moves to the next model in `models` whenever one is busy.
 */
export async function generateJson<T>(opts: {
  system: string;
  parts: (string | Part)[];
  schema: z.ZodType<T>;
  models?: string[];
  maxAttempts?: number;
}): Promise<JsonCallResult<T>> {
  const models = opts.models?.length ? opts.models : FAST_MODELS;
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const maxAttempts = opts.maxAttempts ?? 6;
  let feedback: string | null = null;
  let lastError: unknown;

  let modelIdx = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const model = models[modelIdx % models.length];
    const parts: Part[] = opts.parts.map((p) => (typeof p === "string" ? { text: p } : p));
    if (feedback) parts.push({ text: `Your previous answer was rejected: ${feedback}\nReturn corrected JSON only.` });
    try {
      const res = await ai().models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: opts.system,
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        },
      });
      const text = res.text ?? "";
      const parsed = opts.schema.safeParse(JSON.parse(text));
      if (parsed.success) return { data: parsed.data, model, attempts: attempt };
      feedback = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      lastError = new Error(`Gemini returned JSON that failed validation: ${feedback}`);
    } catch (err) {
      lastError = err;
      feedback = err instanceof SyntaxError ? "the response was not valid JSON" : null;
      if (isBusy(err)) {
        modelIdx++; // move to the next model while this one is overloaded
        await sleep(Math.min(10_000, 1500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * JSON call against a raw JSON schema we didn't write (e.g. AG Grid's own state schema).
 * Interactive callers pass short timeouts: a person is watching, so fail fast rather than wait 45s per model.
 */
export async function generateJsonFromSchema(
  system: string, prompt: string, jsonSchema: Record<string, unknown>,
  opts: { perModelMs?: number; totalMs?: number } = {},
): Promise<unknown> {
  const perModel = opts.perModelMs ?? CALL_TIMEOUT_MS;
  const deadline = Date.now() + (opts.totalMs ?? Infinity);
  let lastError: unknown;
  for (const model of FAST_MODELS) {
    const left = deadline - Date.now();
    if (left < 2_000) break;
    try {
      const res = await ai().models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { systemInstruction: system, temperature: 0, responseMimeType: "application/json", responseJsonSchema: jsonSchema, abortSignal: AbortSignal.timeout(Math.min(perModel, left)), httpOptions: { timeout: Math.min(perModel, left) } },
      });
      return JSON.parse(res.text ?? "{}");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Free-text call (used only for letter wording, where amounts are filled in by code afterwards). */
export async function generateText(system: string, prompt: string): Promise<string> {
  let lastError: unknown;
  for (const model of FAST_MODELS) {
    try {
      const res = await ai().models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { systemInstruction: system, temperature: 0.4, abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
      });
      return res.text ?? "";
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

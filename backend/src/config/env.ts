/**
 * PYROSENSE backend — typed environment configuration.
 *
 * Every credential enters the process HERE and nowhere else: modules import
 * `env`, never `process.env`. Zod parses and validates on first import; a
 * missing required value crashes the process at startup with a clear,
 * actionable error — never a silent failure at request time.
 */

import "dotenv/config";
import { z } from "zod";
/** z.coerce.boolean() treats ANY non-empty string (even "false") as true —
 *  parse explicit false-y strings correctly instead. */
const boolFrom = (v: unknown): boolean =>
  v === true || (typeof v === "string" && ["true", "1", "yes", "on"].includes(v.trim().toLowerCase()));

const schema = z.object({
  /** HTTP listen port (host 0.0.0.0 — reachable from LAN/containers). */
  PORT: z.coerce.number().int().positive().default(4000),

  /**
   * Express `trust proxy` hop count. Render fronts the backend with ONE
   * reverse proxy, so every request arrives with X-Forwarded-For; without
   * trusting that proxy, express-rate-limit keys off Render's proxy IP
   * instead of the real client (and logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
   * Do NOT set true — that trusts the whole chain and lets clients spoof
   * their IP via the header. 1 = trust exactly one hop (the platform proxy).
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),

  /** NASA FIRMS MAP_KEY — required: no key, no detections, no product. */
  FIRMS_MAP_KEY: z
    .string()
    .trim()
    .min(16, "FIRMS_MAP_KEY is missing or too short — get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/"),
  FIRMS_BASE_URL: z
    .string()
    .url()
    .default("https://firms.modaps.eosdis.nasa.gov/api/area/csv"),

  /** Overpass endpoint used by the facility ingestion job. */
  OVERPASS_API_URL: z
    .string()
    .url()
    .default("https://overpass-api.de/api/interpreter"),

  /**
   * GenAI provider (OpenRouter — OpenAI-compatible chat completions). Keys are
   * OPTIONAL by design: without a key the service degrades gracefully to the
   * deterministic templated summary (§5) instead of failing the endpoint.
   */
  OPENROUTER_API_KEY: z.string().trim().optional().default(""),
  OPENROUTER_API_URL: z.string().trim().optional().default("https://openrouter.ai/api/v1"),
  /** Primary model — must respond reliably on the free tier. */
  OPENROUTER_MODEL: z.string().trim().optional().default("nvidia/nemotron-3-super-120b-a12b:free"),
  /**
   * Comma-separated fallback models tried in order when the primary model
   * errors, stalls, or returns no usable content. Nemotron models are
   * reasoning models: reasoning must be disabled explicitly and any
   * leaked <think> block stripped (see genaiService/chatService).
   */
  OPENROUTER_FALLBACK_MODELS: z.string().trim().optional().default("nvidia/nemotron-3.5-lightning:free"),

  /** SQLite file path, relative to backend/ or absolute. */
  DATABASE_URL: z.string().trim().min(1).default("./data/pyrosense.db"),

  /**
   * Base URL of the pyrosense_ml (Python FastAPI) service. The Node backend
   * proxies /api/predict and /api/ml/* to it so the frontend talks to ONE
   * origin — consistent with how FIRMS/Overpass are kept server-side.
   */
  ML_API_BASE_URL: z
    .string()
    .url()
    .default("http://localhost:5000"),

  /**
   * Browser origins allowed by CORS. Special value "*" (or a "*" anywhere in
   * the list) reflects any origin — fine for local dev, do NOT ship to prod.
   *
   * Default covers localhost/127.0.0.1 on ANY port (dev servers hop ports
   * when 3000 is taken — the dashboard must keep working), plus LAN IPs so
   * phones on the same Wi-Fi can open the dashboard. Extra explicit origins
   * are merged in.
   */
  CORS_ORIGIN: z
    .string()
    .trim()
    .default("http://localhost:*,http://127.0.0.1:*,http://192.168.*:*,http://10.*:*,http://172.16.*:*")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  /**
   * On boot, if firms_detections holds fewer than ARCHIVE_BACKFILL_MIN_ROWS,
   * backfill the FIRMS archive for this many days (5-day chunks per region,
   * 1.5s spacing). This keeps a free-plan deployment that loses its disk on
   * every spin-down useful within ~2 minutes of waking instead of showing a
   * day-one dashboard. 0 disables the backfill entirely.
   */
  ARCHIVE_BACKFILL_DAYS: z.coerce.number().int().min(0).max(365).default(10),
  ARCHIVE_BACKFILL_MIN_ROWS: z.coerce.number().int().min(1).default(50_000),

  /**
   * Dev-box escape hatch ONLY: some sandboxed networks block Node's undici
   * (fetch) at the socket level while the OS curl binary still works. Setting
   * this re-enables http.ts's curl fallback for such environments. Leave
   * UNSET in production — container images don't ship curl, and a silent
   * fallback to a missing binary masks the real transport error (the
   * spawn curl ENOENT class of failure). Production fetch problems should
   * surface as fetch errors, not curl spawn errors.
   */
  OUTBOUND_FETCH_FALLBACK_CURL: z.preprocess(boolFrom, z.boolean()).default(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console -- deliberate: this runs before pino exists
  console.error(
    `\n[config] Invalid or missing environment variables — refusing to start:\n${issues}\n` +
      `          Copy backend/.env.example to backend/.env and fill in real values.\n`,
  );
  process.exit(1);
}

export const env = parsed.data;

/**
 * CORS origin matcher. Patterns use `*` as a whole-segment wildcard:
 *   "http://localhost:*"  → any port on localhost
 *   "http://192.168.*:*"  → any LAN IP, any port
 *   "*" (exact)           → reflect ANY origin (dev convenience only)
 */
function originAllowed(origin: string): boolean {
  if (env.CORS_ORIGIN.includes("*")) return true;
  return env.CORS_ORIGIN.some((pattern) => {
    if (!pattern.includes("*")) return pattern === origin;
    const rx = new RegExp(
      "^" + pattern.split("*").map(escapeRx).join(".*") + "$",
    );
    return rx.test(origin);
  });
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the request's Origin header should be allowed. */
export const isOriginAllowed = (origin: string | undefined): boolean => {
  if (!origin) return true; // curl / same-origin / server-to-server
  return originAllowed(origin);
};

/** True when the AI provider is configured. */
export const hasAiProvider = (): boolean =>
  Boolean(env.OPENROUTER_API_KEY);

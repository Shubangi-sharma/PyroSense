/**
 * Outbound HTTP transport with an opt-in curl fallback.
 *
 * fetch() is always tried first. The curl fallback exists ONLY for sandboxed
 * dev networks that block Node's undici at the socket level while the OS
 * curl binary still works — it must be explicitly enabled via
 * OUTBOUND_FETCH_FALLBACK_CURL=true. Production containers don't ship curl,
 * and a silent fallback to a missing binary turned real transport failures
 * into misleading `spawn curl ENOENT` errors (e.g. the Render "af" region
 * ingest failures). Callers never see the mechanism; a request either yields
 * a status+body or throws.
 *
 * Provider queues (§6): every outbound call to FIRMS, Overpass, or a GenAI
 * provider goes through its own p-limit lane, so a burst of frontend
 * requests can never fan out into a burst of external API calls.
 */

import { execFile } from "node:child_process";
import pLimit from "p-limit";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "http" });

const CURL_TIMEOUT_MS = 45_000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 140)}`);
    this.name = "HttpError";
  }
}

function viaCurl(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number = CURL_TIMEOUT_MS,
): Promise<string> {
  const args: string[] = [
    "-sf",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "-X",
    init.method ?? "GET",
  ];
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    args.push("-H", `${k}: ${v}`);
  }
  if (init.body !== undefined) args.push("--data", init.body);
  args.push(url);

  return new Promise<string>((resolve, reject) => {
    execFile(
      "curl",
      args,
      { timeout: timeoutMs + 5_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`curl transport failed for ${url}: ${err.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export interface HttpResult {
  status: number;
  text: string;
}

/**
 * POST/GET with the fetch → curl fallback. Returns text; callers parse.
 * `allowHttpError` lets callers accept 4xx/5xx bodies (some APIs return
 * useful error text in the body) instead of throwing.
 */
export async function httpRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  opts: { allowHttpError?: boolean; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const { method = "GET", headers = {}, body } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  try {
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      if (!res.ok && !opts.allowHttpError) {
        throw new HttpError(res.status, url, text);
      }
      return { status: res.status, text };
    } catch (err) {
      // A real HTTP status response should NOT trigger the curl fallback —
      // only transport-level failures (DNS, TLS, timeout, connection reset).
      if (err instanceof HttpError) throw err;
      // Opt-in only (OUTBOUND_FETCH_FALLBACK_CURL): production images have no
      // curl binary, and silently spawning a missing binary turns a real
      // transport error into a misleading `spawn curl ENOENT`.
      if (!env.OUTBOUND_FETCH_FALLBACK_CURL) throw err;
      log.debug({ url: url.split("?")[0], err: String(err) }, "fetch transport failed, falling back to curl");
      const text = await viaCurl(url, { method, headers, body }, opts.timeoutMs ?? CURL_TIMEOUT_MS);
      return { status: 200, text };
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Provider concurrency lanes (§6 rate limiting / backpressure)         */
/* ------------------------------------------------------------------ */

/** Max in-flight outbound calls per external provider. */
export const FIRMS_QUEUE = pLimit(2); // NASA rate limit headroom
export const OVERPASS_QUEUE = pLimit(1); // public community instance — be gentle
export const GENAI_QUEUE = pLimit(2); // summaries are cached anyway

"use client";

import React, { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Activity, CheckCircle2, Loader2, RefreshCw, Server, XCircle, Zap } from "lucide-react";
import { STATUS_META, STATUS_ORDER } from "@/lib/types";
import { StatusGlyph } from "@/lib/status";
import { FRP_BANDS } from "@/lib/firms";
import {
  fetchBackendHealth,
  fetchMlHealth,
  runPipeline,
  type BackendHealthDto,
  type MlHealthDto,
  type PipelineReport,
} from "@/lib/opsApi";

const STATUS_HELP: Record<string, string> = {
  normal: "No thermal detections within the 5 km corroboration radius.",
  watch: "Detections present but steady - FRP in line with the site's own history.",
  suspicious: "New activity in the last 5 days, or FRP ≥ ~1.3× the site's baseline.",
  critical: "FRP far above the site's recency-weighted baseline (≥ 2×). Act now.",
  unknown: "Detections nearby, but sensor confidence too low to classify.",
};

/* ------------------------------------------------------------------ */
/* toggle                                                               */
/* ------------------------------------------------------------------ */

function Toggle({
  label,
  description,
  defaultOn = false,
}: {
  label: string;
  description: string;
  defaultOn?: boolean;
}) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="flex items-center gap-4 border-b border-border-hairline py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{label}</p>
        <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => setOn((v) => !v)}
        className={clsx(
          "relative ml-auto h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200",
          on ? "bg-accent-primary" : "bg-border-strong",
        )}
      >
        <span
          className={clsx(
            "absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-all duration-200",
            on ? "left-6" : "left-1",
          )}
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* system status                                                        */
/* ------------------------------------------------------------------ */

function uptimeLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function timeLabel(iso: string | null): string {
  if (!iso) return "never";
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

function ServiceCard({
  title,
  ok,
  meta,
  children,
}: {
  title: string;
  ok: boolean;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <div className="dash-card rounded-xl p-4">
      <div className="flex items-center gap-2.5">
        {ok ? (
          <CheckCircle2 size={15} className="text-status-normal" />
        ) : (
          <XCircle size={15} className="text-status-critical" />
        )}
        <span className="text-sm font-medium text-text-primary">{title}</span>
        <span className="ml-auto font-mono text-[10px] text-text-tertiary">{meta}</span>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-[11px] text-text-tertiary">{label}</span>
      <span className="font-mono text-[11px] text-text-secondary">{value}</span>
    </div>
  );
}

function SystemStatusSection() {
  const [backend, setBackend] = useState<BackendHealthDto | null>(null);
  const [ml, setMl] = useState<MlHealthDto | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [checking, setChecking] = useState(true);
  const [pipelineDays, setPipelineDays] = useState(10);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineReport, setPipelineReport] = useState<PipelineReport | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setLoadError(false);
    const results = await Promise.allSettled([fetchBackendHealth(), fetchMlHealth()]);
    setBackend(results[0].status === "fulfilled" ? results[0].value : null);
    setMl(results[1].status === "fulfilled" ? results[1].value : null);
    setLoadError(results.every((r) => r.status === "rejected"));
    setChecking(false);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const triggerPipeline = useCallback(async () => {
    setPipelineBusy(true);
    setPipelineError(null);
    setPipelineReport(null);
    try {
      const report = await runPipeline(pipelineDays);
      setPipelineReport(report);
      void check();
    } catch (err) {
      setPipelineError(err instanceof Error ? err.message : "pipeline failed");
    } finally {
      setPipelineBusy(false);
    }
  }, [pipelineDays, check]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-tertiary">
          System Status
        </h2>
        <button
          type="button"
          onClick={() => void check()}
          aria-label="Re-check"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-bg-raised hover:text-text-primary"
        >
          <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
        </button>
      </div>

      {loadError && !backend && !ml ? (
        <div className="dash-card rounded-xl p-4 text-xs text-status-watch">
          Backend unreachable - is the Node backend running (default http://localhost:4000)?
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <ServiceCard
            title="Node Backend"
            ok={backend?.status === "ok"}
            meta={backend ? `up ${uptimeLabel(backend.uptimeSec)}` : "unreachable"}
          >
            {backend ? (
              <div className="divide-y divide-border-hairline">
                <KV label="Detections stored" value={backend.db.rows.toLocaleString("en-IN")} />
                <KV label="Archive window" value={`${backend.db.minDate ?? "-"} → ${backend.db.maxDate ?? "-"}`} />
                <KV label="Last FIRMS refresh" value={timeLabel(backend.lastRefresh)} />
                <KV label="Last facility ingest" value={timeLabel(backend.lastFacilityIngest)} />
              </div>
            ) : (
              <p className="text-xs text-text-tertiary">No response from /health.</p>
            )}
          </ServiceCard>

          <ServiceCard
            title="ML Service (pyrosense_ml)"
            ok={ml?.model_loaded === true && ml?.postgres_connected === true}
            meta={ml ? `schema v${ml.feature_schema_version}` : "unreachable"}
          >
            {ml ? (
              <div className="divide-y divide-border-hairline">
                <KV label="Models loaded" value={ml.model_loaded ? (ml.classifiers_available ?? ["mlp"]).join(", ") : "no"} />
                <KV label="Postgres" value={ml.postgres_connected ? "connected" : "disconnected"} />
                <KV label="Feature schema" value={`${ml.feature_count} features`} />
                <KV label="Model / dataset" value={`v${ml.model_version} / v${ml.dataset_version}`} />
              </div>
            ) : (
              <p className="text-xs text-text-tertiary">ML service unreachable.</p>
            )}
          </ServiceCard>
        </div>
      )}

      {/* pipeline trigger */}
      <div className="dash-card rounded-xl p-4">
        <div className="flex items-center gap-2">
          <Zap size={15} className="text-accent-primary" />
          <h3 className="text-sm font-medium text-text-primary">ML Pipeline</h3>
        </div>
        <p className="mt-1.5 text-xs text-text-secondary">
          Ingests FIRMS detections, fetches weather, aggregates H3 cells, and scores
          risk + hotspot clusters. Can take up to ~10 minutes.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            value={pipelineDays}
            onChange={(e) => setPipelineDays(Number(e.target.value))}
            disabled={pipelineBusy}
            className="rounded-lg border border-border-hairline bg-bg-void px-2.5 py-1.5 font-mono text-xs text-text-primary"
          >
            {[3, 7, 10, 21, 30].map((d) => (
              <option key={d} value={d}>{d} days</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void triggerPipeline()}
            disabled={pipelineBusy}
            className={clsx(
              "flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-medium transition-colors",
              pipelineBusy
                ? "cursor-wait bg-bg-void text-text-tertiary"
                : "bg-accent-primary text-bg-void hover:opacity-90",
            )}
          >
            {pipelineBusy && <Loader2 size={13} className="animate-spin" />}
            {pipelineBusy ? "Running…" : "Run pipeline"}
          </button>
        </div>
        {pipelineError && (
          <p className="mt-2 rounded-lg bg-bg-void px-3 py-2 text-xs text-status-watch">
            {pipelineError}
          </p>
        )}
        {pipelineReport && (
          <pre className="pyro-scroll mt-3 max-h-40 overflow-auto rounded-lg bg-bg-void p-3 font-mono text-[10px] text-text-secondary">
            {JSON.stringify(pipelineReport, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  return (
    <div className="pyro-scroll h-full overflow-y-auto bg-gradient-mesh">
      <div className="mx-auto flex max-w-[800px] flex-col gap-6 p-6 pb-20">
        <header className="pt-3">
          <h1 className="font-display text-2xl font-semibold text-text-primary">Settings</h1>
          <p className="mt-0.5 text-sm text-text-secondary">
            Workspace preferences and system operations
          </p>
        </header>

        {/* preferences */}
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-tertiary">
            Preferences
          </h2>
          <div className="dash-card rounded-xl px-5 py-1">
            <Toggle
              label="Critical incident notifications"
              description="Bell badge and banner for new critical classifications"
              defaultOn
            />
            <Toggle
              label="Timeline auto-replay"
              description="Start timeline replay automatically when the map loads"
            />
            <Toggle
              label="Unfiltered satellite tiles"
              description="Always render satellite imagery without the dark filter"
              defaultOn
            />
            <Toggle
              label="Low-bandwidth tile mode"
              description="Reduce tile refresh rate on constrained links"
            />
          </div>
        </div>

        {/* system status */}
        <SystemStatusSection />

        {/* map guide */}
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-tertiary">
            Map Legend Guide
          </h2>

          <div className="dash-card rounded-xl p-5">
            <h3 className="mb-1 text-sm font-medium text-text-primary">Risk Statuses</h3>
            <p className="mb-3 text-xs text-text-secondary">
              Each facility is classified by comparing recent thermal detections
              against its own baseline - never against other sites.
            </p>
            <div className="space-y-2">
              {STATUS_ORDER.map((s) => (
                <div key={s} className="flex items-start gap-2.5 rounded-lg border border-border-hairline bg-bg-inset/30 px-3 py-2">
                  <StatusGlyph status={s} size={10} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <span className="text-xs font-semibold" style={{ color: STATUS_META[s].hex }}>
                      {STATUS_META[s].label}
                    </span>
                    <p className="text-[11px] text-text-tertiary">{STATUS_HELP[s]}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="dash-card rounded-xl p-5">
            <h3 className="mb-1 text-sm font-medium text-text-primary">FRP Bands</h3>
            <p className="mb-3 text-xs text-text-secondary">
              Fire Radiative Power in megawatts - the radiant heat output.
            </p>
            <div className="space-y-2">
              {FRP_BANDS.map((band) => (
                <div key={band.label} className="flex items-center gap-2.5">
                  <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: band.color }} />
                  <span className="font-mono text-xs text-text-secondary">{band.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dash-card rounded-xl p-5">
            <h3 className="mb-1 text-sm font-medium text-text-primary">Risk Score</h3>
            <p className="text-xs text-text-secondary">
              The 0–100 ring on each facility (higher = more risk) blends three
              signals: thermal FRP behaviour vs the site&apos;s own baseline,
              an ML classification of the site&apos;s environment (land cover,
              infrastructure, weather) and GRU fire-risk forecasts for the
              area. Signals that are unavailable are renormalized — the
              provenance lists what actually contributed. Click any marker on
              the map for the breakdown.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

/**
 * About System — explains architecture, data sources, and classification
 * vocabularies. Static documentation surface, no data fetching.
 */

import React from "react";
import Link from "next/link";
import {
  Brain,
  Code2,
  Database,
  ExternalLink,
  Layers,
  Monitor,
  Satellite,
  Server,
  Shield,
} from "lucide-react";
import { MODEL_CLASSES, MODEL_CLASS_LABELS, MODEL_CLASS_COLORS } from "@/lib/mlApi";
import { STATUS_META, STATUS_ORDER } from "@/lib/types";
import { StatusGlyph } from "@/lib/status";

function InfoCard({
  icon: Icon,
  title,
  children,
  accent,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="dash-card rounded-xl p-5">
      <div className="mb-3 flex items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: `${accent ?? "rgba(91,155,213,0.15)"}` }}
        >
          <Icon size={17} style={{ color: accent ? accent.replace("0.15", "0.8") : "#5B9BD5" }} />
        </div>
        <h3 className="font-display text-sm font-semibold text-text-primary">{title}</h3>
      </div>
      <div className="text-xs leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

export default function AboutPage() {
  return (
    <div className="pyro-scroll h-full overflow-y-auto bg-gradient-mesh">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 p-6 pb-20">
        <header className="pt-3">
          <h1 className="font-display text-2xl font-semibold text-text-primary">
            About PyroSense
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
            An end-to-end platform for detecting, classifying, and prioritizing
            industrial thermal anomalies using NASA satellite data and machine
            learning - grounded entirely in real observations.
          </p>
        </header>

        {/* ── Architecture ──────────────────────────────────────────── */}
        <div>
          <h2 className="mb-3 font-display text-[13px] font-semibold uppercase tracking-wider text-text-tertiary">
            System Architecture
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <InfoCard icon={Monitor} title="Frontend" accent="rgba(91,155,213,0.15)">
              <p>
                <strong className="text-text-primary">Next.js 14</strong> · Port 3000
              </p>
              <p className="mt-1.5">
                Pure presentation layer. No secrets, no computation, no
                direct database access - every number on every page arrives
                from a backend API call.
              </p>
            </InfoCard>
            <InfoCard icon={Server} title="Monitoring Backend" accent="rgba(79,179,179,0.15)">
              <p>
                <strong className="text-text-primary">Node/Express + SQLite WAL</strong> · Port 4000
              </p>
              <p className="mt-1.5">
                FIRMS ingestion, OSM facility matching, thermal fingerprinting,
                What-Changed analysis, unified Risk Score, grounded GenAI
                narratives, and the ML proxy.
              </p>
            </InfoCard>
            <InfoCard icon={Brain} title="ML Service" accent="rgba(145,134,196,0.15)">
              <p>
                <strong className="text-text-primary">Python FastAPI</strong> · Port 5000
              </p>
              <p className="mt-1.5">
                43-feature MLP classifier with 5 output categories. Feature engineering
                from satellite data, land cover, weather, and infrastructure
                distances happens entirely server-side.
              </p>
            </InfoCard>
          </div>
        </div>

        {/* ── Data Sources ──────────────────────────────────────────── */}
        <div>
          <h2 className="mb-3 font-display text-[13px] font-semibold uppercase tracking-wider text-text-tertiary">
            Data Sources & Provenance
          </h2>
          <div className="dash-card rounded-xl divide-y divide-border-hairline">
            {[
              {
                icon: Satellite,
                name: "NASA FIRMS (VIIRS S-NPP NRT)",
                desc: "Active-fire detections ingested in 5-day chunks over a 365-day rolling window, refreshed every 15 minutes.",
              },
              {
                icon: Layers,
                name: "OpenStreetMap Overpass",
                desc: "Industrial facility catalogue ingested at deployment. Live requests never touch Overpass directly.",
              },
              {
                icon: Database,
                name: "Dynamic World + Open-Meteo",
                desc: "Land-cover ratios and weather aggregates, computed per-point by the ML service during prediction.",
              },
              {
                icon: Code2,
                name: "Grounded GenAI",
                desc: "Summaries generated only from computed facts (temperature 0), with deterministic template fallbacks. Missing data shows honest empty states.",
              },
            ].map(({ icon: Icon, name, desc }) => (
              <div key={name} className="flex items-start gap-3 p-4">
                <Icon size={15} className="mt-0.5 flex-shrink-0 text-accent-secondary" />
                <div>
                  <p className="text-sm font-medium text-text-primary">{name}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Two Vocabularies ───────────────────────────────────────── */}
        <div>
          <h2 className="mb-3 font-display text-[13px] font-semibold uppercase tracking-wider text-text-tertiary">
            Classification Vocabularies
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {/* rule-based */}
            <div className="dash-card rounded-xl p-5">
              <div className="mb-1 flex items-center gap-2">
                <Shield size={15} className="text-accent-primary" />
                <h3 className="font-display text-sm font-semibold text-text-primary">
                  Risk Status
                </h3>
              </div>
              <p className="mb-3 text-[11px] text-text-tertiary">
                Rule-based · behavioural monitoring
              </p>
              <p className="mb-3 text-xs leading-relaxed text-text-secondary">
                Real-time classification comparing recent detections against each
                site&apos;s own recency-weighted thermal baseline.
              </p>
              <div className="space-y-2">
                {STATUS_ORDER.map((s) => (
                  <div key={s} className="flex items-center gap-2.5 rounded-lg border border-border-hairline bg-bg-inset/30 px-3 py-2">
                    <StatusGlyph status={s} size={9} />
                    <span className="text-xs font-medium" style={{ color: STATUS_META[s].hex }}>
                      {STATUS_META[s].label}
                    </span>
                    <span className="ml-auto font-mono text-[9px] text-text-tertiary">
                      {STATUS_META[s].tag}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* ML model */}
            <div className="dash-card rounded-xl p-5">
              <div className="mb-1 flex items-center gap-2">
                <Brain size={15} className="text-accent-violet" />
                <h3 className="font-display text-sm font-semibold text-text-primary">
                  Predicted Hotspot Category
                </h3>
              </div>
              <p className="mb-3 text-[11px] text-text-tertiary">
                ML model · supervised classification
              </p>
              <p className="mb-3 text-xs leading-relaxed text-text-secondary">
                The MLP model&apos;s output for a submitted point, trained on
                labelled historical hotspots. Shown on the{" "}
                <Link href="/predict" className="text-accent-primary hover:underline">
                  Predict
                </Link>{" "}
                page.
              </p>
              <div className="space-y-2">
                {MODEL_CLASSES.map((c) => (
                  <div key={c} className="flex items-center gap-2.5 rounded-lg border border-border-hairline bg-bg-inset/30 px-3 py-2">
                    <span
                      className="inline-block h-[9px] w-[9px] rounded-full"
                      style={{ backgroundColor: MODEL_CLASS_COLORS[c] }}
                    />
                    <span className="text-xs font-medium text-text-primary">
                      {MODEL_CLASS_LABELS[c]}
                    </span>
                    <span className="ml-auto font-mono text-[9px] text-text-tertiary">
                      {c}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── Tech Stack ────────────────────────────────────────────── */}
        <div className="dash-card rounded-xl p-5">
          <h2 className="mb-3 font-display text-sm font-semibold text-text-primary">
            Technology Stack
          </h2>
          <div className="flex flex-wrap gap-2">
            {[
              "Next.js 14",
              "React 18",
              "TypeScript",
              "Tailwind CSS",
              "Leaflet",
              "SWR",
              "Recharts",
              "Node.js",
              "Express",
              "SQLite WAL",
              "Python",
              "FastAPI",
              "scikit-learn",
              "PostgreSQL",
              "H3 Hexagonal",
            ].map((tech) => (
              <span
                key={tech}
                className="rounded-md border border-border-hairline bg-bg-inset/40 px-2.5 py-1 font-mono text-[10px] text-text-secondary"
              >
                {tech}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

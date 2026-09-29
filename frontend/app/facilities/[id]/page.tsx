"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowLeft, Map as MapIcon, Satellite } from "lucide-react";
import { StatusBadge } from "@/lib/status";
import SignalQualityBadge from "@/components/SignalQualityBadge";
import RiskScoreRing from "@/components/RiskScoreRing";
import WhatChangedPanel from "@/components/WhatChangedPanel";
import AiSummaryBlock from "@/components/AiSummaryBlock";
import IncidentTimeline from "@/components/IncidentTimeline";
import ObservationsPanels from "@/components/ObservationsPanels";
import PinButton from "@/components/PinButton";
import FireTagCard from "@/components/FireTagCard";
import { fetchFacilityAnalysis, fetchSummary } from "@/lib/api";
import PyroLoader from "@/components/PyroLoader";
import { FacilityNarrative, RiskStatus } from "@/lib/types";
import type { FacilityAnalysisResponseDto, SummaryResponseDto } from "@/lib/api";

const MiniMapInner = dynamic(() => import("@/components/MiniMapInner"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-bg-base" />,
});

function MonoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-hairline bg-bg-inset px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-sm text-text-primary">
        {value}
      </div>
    </div>
  );
}

/** Section shell for PDF §4 field groups with an honest empty state. */
function FieldGroupSection({
  title,
  note,
  empty,
  children,
}: {
  title: string;
  note?: string;
  empty?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className="dash-card rounded-xl p-5">
      <h3 className="font-display text-sm font-semibold text-text-primary">{title}</h3>
      {note && <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">{note}</p>}
      {empty ? (
        <p className="mt-3 rounded-lg border border-border-hairline bg-bg-raised px-3 py-2 text-xs leading-relaxed text-text-secondary">
          Not measured for this facility - these observations are computed
          during ML feature engineering, not stored per facility. Run the
          Predict page on this facility&apos;s coordinates to generate them.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>
      )}
    </section>
  );
}

/** Highest-count entry of a split map, e.g. satellites. */
function topSplit(split: Record<string, number>): string {
  const entries = Object.entries(split);
  if (entries.length === 0) return "-";
  return entries.sort((a, b) => b[1] - a[1])[0]![0];
}

export default function FacilityDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const osmId = params.id;

  // The facility's identity, status and narrative all come from the backend.
  const [analysis, setAnalysis] = useState<FacilityAnalysisResponseDto | null>(null);
  const [summary, setSummary] = useState<SummaryResponseDto | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setSummary(null);
    setError(false);

    fetchFacilityAnalysis(osmId)
      .then((r) => {
        if (!cancelled) setAnalysis(r);
        return null;
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    fetchSummary(osmId)
      .then((r) => {
        if (!cancelled) setSummary(r);
        return null;
      })
      .catch(() => {
        /* summary errors are non-fatal — the template fallback is served */
      });

    return () => {
      cancelled = true;
    };
  }, [osmId]);

  const facility = analysis?.facility;
  const cls = typeof analysis?.classification === "string" ? null : analysis?.classification;
  const status = (cls?.status ?? (analysis?.classification as RiskStatus | undefined)) as
    | RiskStatus
    | undefined;

  const [satellite, setSatellite] = useState(false);
  useEffect(() => {
    document.title = facility
      ? `${facility.name} - PYROSENSE`
      : "Facility - PYROSENSE";
  }, [facility]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <p className="text-sm text-text-secondary">
          Live facility feed unavailable - retrying automatically.
        </p>
        <Link
          href="/facilities"
          className="text-xs font-medium text-accent-primary hover:text-accent-secondary"
        >
          ← Back to Facility Explorer
        </Link>
      </div>
    );
  }

  if (!analysis || !facility || !status || !cls) {
    return (
      <div className="flex h-full items-center justify-center">
        <PyroLoader
          label="Loading facility dossier"
          sub="Pulling the classification, narrative and detection history for this site"
        />
      </div>
    );
  }

  const narrative: FacilityNarrative = {
    whatChanged: analysis.narrative.whatChanged,
    timeline: analysis.narrative.timeline,
  };
  const c = cls;
  const p = analysis.persistence ?? {
    totalDetections: 0,
    uniqueDays: 0,
    activeDurationDays: null,
    firstDetectionDate: null,
    lastDetectionDate: null,
  };
  const fc = analysis.fireCharacteristics ?? {
    meanFrp: null,
    maxFrp: null,
    minFrp: null,
    latestBrightnessK: null,
    dayNightSplit: { day: 0, night: 0 },
    confidenceSplit: {},
    satelliteSplit: {},
  };

  return (
    <div className="pyro-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-6 p-6 pb-20">
        {/* header */}
        <header className="flex flex-col gap-3 pt-4">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex w-fit items-center gap-1.5 text-xs text-text-tertiary transition-colors duration-150 hover:text-text-primary"
          >
            <ArrowLeft size={13} />
            Back
          </button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl font-semibold text-text-primary">
              {facility.name}
            </h1>
            <StatusBadge status={status} />
            <div className="ml-auto w-[220px]">
              <PinButton facilityId={facility.id} facilityName={facility.name} />
            </div>
          </div>
          <p className="text-sm text-text-secondary">
            {facility.type} · OpenStreetMap {facility.id.replace("osm-", "")} · status
            computed from the FIRMS archive by the PYROSENSE backend
          </p>
        </header>

        {/* 2-column body */}
        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          {/* LEFT: risk + locator */}
          <div className="flex flex-col gap-6">
            <section className="dash-card flex flex-col items-center gap-5 rounded-xl p-6">
              <RiskScoreRing
                score={analysis.riskScore?.riskScore ?? c.score}
                status={status}
              />
              <SignalQualityBadge split={c.liveConfidenceSplit} />
              <div className="grid w-full grid-cols-2 gap-3">
                <MonoStat
                  label="FRP (latest)"
                  value={c.latestFrp != null ? `${c.latestFrp.toFixed(1)} MW` : "no detection"}
                />
                <MonoStat
                  label="Coordinates"
                  value={`${facility.lat.toFixed(2)}°, ${facility.lng.toFixed(2)}°`}
                />
                <MonoStat label="Type" value={facility.type} />
                <MonoStat
                  label="Detections (10d)"
                  value={String(c.detectionCount)}
                />
              </div>
              {c.detectionCount === 0 && (
                <p className="text-center text-xs text-text-secondary">
                  No thermal activity detected within 5 km in the last 10 days.
                </p>
              )}
            </section>

            {/* locator mini-map - switchable to satellite imagery */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between px-1">
                <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-text-secondary">
                  Locator
                </h2>
                <button
                  type="button"
                  onClick={() => setSatellite((s) => !s)}
                  aria-pressed={satellite}
                  className="flex items-center gap-1.5 rounded-md border border-border-hairline bg-bg-surface px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
                >
                  <Satellite size={12} />
                  {satellite ? "Dark view" : "View satellite"}
                </button>
              </div>
              <div className="h-[280px] overflow-hidden rounded-xl border border-border-hairline">
                <MiniMapInner
                  lat={facility.lat}
                  lng={facility.lng}
                  name={facility.name}
                  satellite={satellite}
                />
              </div>
              <p className="px-1 text-[11px] leading-relaxed text-text-tertiary">
                Satellite imagery renders unfiltered for visual verification of
                thermal signatures.
              </p>
              {/* jump straight onto the Hotspot Map at this exact location */}
              <Link
                href={`/map?lat=${facility.lat}&lng=${facility.lng}&zoom=13`}
                className="group flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-semibold text-white transition-all duration-200"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(91,155,213,0.32) 0%, rgba(79,179,179,0.28) 100%)",
                  border: "1px solid rgba(91,155,213,0.4)",
                }}
              >
                <MapIcon size={13} />
                Open on Hotspot Map
              </Link>
            </section>
          </div>

          {/* RIGHT: narrative stack - computed by the backend, AI grounded in facts */}
          <div className="flex min-w-0 flex-col gap-6">
            {/* contextual predicted fire type — what is actually burning here */}
            <FireTagCard
              tag={analysis.predictedTag?.tag}
              confidence={analysis.predictedTag?.confidence}
              reasons={analysis.predictedTag?.reasons}
              provenance={analysis.predictedTag?.provenance}
            />

            <WhatChangedPanel rows={narrative.whatChanged} />

            {/* PDF §4: Persistence group - computed from the stored archive */}
            <FieldGroupSection title="Persistence">
              <MonoStat
                label="Total detections"
                value={p.totalDetections > 0 ? String(p.totalDetections) : "none"}
              />
              <MonoStat
                label="Unique active days"
                value={p.uniqueDays > 0 ? String(p.uniqueDays) : "-"}
              />
              <MonoStat
                label="Active duration"
                value={p.activeDurationDays != null ? `${p.activeDurationDays} days` : "-"}
              />
              <MonoStat label="First detection" value={p.firstDetectionDate ?? "-"} />
              <MonoStat label="Last detection" value={p.lastDetectionDate ?? "-"} />
            </FieldGroupSection>

            {/* PDF §4: Fire characteristics group */}
            <FieldGroupSection title="Fire characteristics">
              <MonoStat
                label="Mean FRP"
                value={fc.meanFrp != null ? `${fc.meanFrp.toFixed(1)} MW` : "-"}
              />
              <MonoStat
                label="Peak FRP"
                value={fc.maxFrp != null ? `${fc.maxFrp.toFixed(1)} MW` : "-"}
              />
              <MonoStat
                label="Min FRP"
                value={fc.minFrp != null ? `${fc.minFrp.toFixed(1)} MW` : "-"}
              />
              <MonoStat
                label="Latest brightness"
                value={fc.latestBrightnessK != null ? `${fc.latestBrightnessK.toFixed(0)} K` : "-"}
              />
              <MonoStat
                label="Day / night passes"
                value={`${fc.dayNightSplit.day} / ${fc.dayNightSplit.night}`}
              />
              <MonoStat
                label="Top satellite"
                value={topSplit(fc.satelliteSplit)}
              />
            </FieldGroupSection>

            {/* PDF §4: Land cover + Surroundings + Weather - computed LIVE by
                the ML service's feature modules (GET /observations via the
                backend proxy). Unknowns render as "-", never fabricated
                numbers (info.md rule). */}
            <ObservationsPanels lat={facility.lat} lng={facility.lng} />

            <AiSummaryBlock
              text={summary?.text ?? "Generating grounded summary…"}
              provider={summary?.provider}
            />
            <IncidentTimeline events={narrative.timeline} />
          </div>
        </div>
      </div>
    </div>
  );
}

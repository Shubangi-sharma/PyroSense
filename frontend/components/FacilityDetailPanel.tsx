"use client";

import React from "react";
import { X, Satellite, ExternalLink } from "lucide-react";
import BrandMark from "@/components/BrandMark";
import { FacilityAnalysis, RiskStatus, FacilityNarrative, statusColorHex } from "@/lib/types";
import { StatusBadge } from "@/lib/status";
import RiskScoreRing from "@/components/RiskScoreRing";
import WhatChangedPanel from "@/components/WhatChangedPanel";
import AiSummaryBlock from "@/components/AiSummaryBlock";
import IncidentTimeline from "@/components/IncidentTimeline";
import PinButton from "@/components/PinButton";
import { FireTagChip, FireTagFocus } from "@/components/FireTagCard";

/** Small mono readout. */
function MonoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-hairline bg-bg-inset px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-xs text-text-primary">
        {value}
      </div>
    </div>
  );
}

export default function FacilityDetailPanel({
  analysis,
  narrative,
  summary,
  timelineActiveIndex,
  onClose,
  onViewSatellite,
  onOpenFullPage,
}: {
  analysis: FacilityAnalysis;
  narrative: FacilityNarrative | null;
  summary: { text: string; provider: string } | null;
  /** Replay (Track B): highlights the timeline step currently shown. */
  timelineActiveIndex?: number | null;
  onClose: () => void;
  onViewSatellite: () => void;
  onOpenFullPage: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      {/* header - status colour carries the identity, no competing card chrome */}
      <div className="relative flex items-start gap-3 overflow-hidden border-b border-border-hairline p-5 pb-4">
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(140% 160% at 8% 0%, rgba(91,155,213,0.07) 0%, transparent 60%)",
          }}
        />
        <div className="relative min-w-0">
          <h2 className="font-display text-lg font-semibold leading-snug text-text-primary">
            {analysis.facility.name}
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            {analysis.facility.type} · {analysis.facility.source === "user_dataset" ? "User Dataset" : "OSM"} {analysis.facility.id.replace("osm-", "")}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={analysis.status} />
            {analysis.predictedTag && analysis.predictedTag.tag !== "unknown" && (
              <FireTagChip
                tag={analysis.predictedTag.tag}
                confidence={analysis.predictedTag.confidence}
              />
            )}
            {analysis.detectionCount > 0 && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-secondary"
                style={{ backgroundColor: "rgba(79,179,179,0.14)" }}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent-secondary" />
                FIRMS-confirmed
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close facility detail"
          className="relative ml-auto flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors duration-150 hover:bg-bg-raised hover:text-text-primary"
        >
          <X size={16} />
        </button>
      </div>

      {/* body */}
      {narrative ? (
        <div className="pyro-scroll flex-1 space-y-5 overflow-y-auto p-5">
          {/* scores + telemetry */}
          <div className="flex items-center gap-5 rounded-xl bg-bg-surface p-5">
            <RiskScoreRing score={analysis.riskScore} status={analysis.status as RiskStatus} />
            <div className="ml-auto grid w-[140px] grid-cols-1 gap-2">
              <MonoStat label="Type" value={analysis.facility.type} />
              <MonoStat
                label="Coordinates"
                value={`${analysis.facility.lat.toFixed(2)}°, ${analysis.facility.lng.toFixed(2)}°`}
              />
              <MonoStat
                label="FRP (latest)"
                value={analysis.latestFrp != null ? `${analysis.latestFrp.toFixed(1)} MW` : "no detection"}
              />
              <MonoStat
                label="Detections"
                value={String(analysis.detectionCount)}
              />
            </div>
          </div>

          {/* contextual fire type — the "what is actually burning" focus
              callout, sitting directly under the Risk Score */}
          <FireTagFocus
            tag={analysis.predictedTag?.tag}
            confidence={analysis.predictedTag?.confidence}
            reasons={analysis.predictedTag?.reasons}
            provenance={analysis.predictedTag?.provenance}
            onOpenFull={onOpenFullPage}
          />

          {analysis.detectionCount === 0 && (
            <p className="rounded-lg border border-border-hairline bg-bg-raised px-3 py-2 text-xs text-text-secondary">
              No thermal activity detected - this facility sits in a quiet
              region of the current FIRMS window.
            </p>
          )}

          {/* actions - full page first, it's the primary destination */}
          <div className="grid grid-cols-1 gap-2">
            <PinButton
              facilityId={analysis.facility.id}
              facilityName={analysis.facility.name}
            />
            <button
              type="button"
              onClick={onOpenFullPage}
              className="group flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-semibold text-white transition-all duration-200"
              style={{
                background:
                  "linear-gradient(135deg, rgba(91,155,213,0.32) 0%, rgba(79,179,179,0.28) 100%)",
                border: "1px solid rgba(91,155,213,0.4)",
              }}
            >
              <ExternalLink size={13} />
              Open full facility page
            </button>
            <button
              type="button"
              onClick={onViewSatellite}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-hairline bg-bg-raised py-2.5 text-xs font-medium text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary"
            >
              <Satellite size={14} />
              Verify in satellite view
            </button>
          </div>

          <WhatChangedPanel rows={narrative.whatChanged} />
          <AiSummaryBlock text={summary?.text ?? "Generating grounded summary…"} provider={summary?.provider} />
          <IncidentTimeline
            events={narrative.timeline}
            activeIndex={timelineActiveIndex}
          />

          <p className="flex items-center justify-center gap-1.5 pb-1 text-[10px] text-text-tertiary">
            <BrandMark size={11} />
            Classified by PYROSENSE from the stored FIRMS archive
          </p>
        </div>
      ) : (
        <div className="pyro-scroll flex-1 space-y-5 overflow-y-auto p-5" aria-hidden>
          <div className="flex items-center gap-5 rounded-xl bg-bg-surface p-5">
            <div className="h-[120px] w-[120px] animate-pulse rounded-full bg-bg-raised" />
            <div className="ml-auto grid w-[150px] grid-cols-1 gap-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-lg bg-bg-raised" />
              ))}
            </div>
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-bg-surface" />
          ))}
        </div>
      )}
    </div>
  );
}

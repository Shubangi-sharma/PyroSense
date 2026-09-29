"use client";

import React from "react";
import { RiskStatus, statusColorHex } from "@/lib/types";
import { StatusBadge } from "@/lib/status";

const SIZE = 120;
const STROKE = 8;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

/**
 * Unified Risk Score ring — 0–100, HIGHER = MORE RISK.
 *
 * Fill direction: MORE filled = MORE urgent (a facility operator scanning a
 * dashboard reads "more filled = act sooner", consistent with the map's
 * existing risk colours where red/high = the alarming end). An empty ring is
 * a quiet site, not a perfect one.
 */
export default function RiskScoreRing({
  score,
  status,
}: {
  score: number;
  status: RiskStatus;
}) {
  const hex = statusColorHex(status);
  const fraction = Math.max(0, Math.min(100, score)) / 100;

  return (
    <div
      className="flex flex-col items-center gap-3"
      role="img"
      aria-label={`Risk score ${score} of 100, higher means more risk - ${status}`}
    >
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} className="-rotate-90">
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke="#1A2028"
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            stroke={hex}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - fraction)}
            style={{ transition: "stroke-dashoffset 400ms ease, stroke 400ms ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-baseline">
            <span className="font-display text-[32px] font-semibold leading-none text-text-primary">
              {score}
            </span>
            <span className="ml-1 font-mono text-xs text-text-tertiary">/100</span>
          </div>
        </div>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

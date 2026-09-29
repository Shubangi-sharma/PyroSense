"use client";

/**
 * PYROSENSE — facility-scoped replay state (Track B).
 *
 * Replay walks REAL detections (FIRMS acquisition timestamps) for ONE
 * facility, oldest → newest. One shared `ReplayState` drives every replayed
 * surface at once — map marker filter, replay label, incident timeline
 * highlight, and the "Today's assessment" score panel — so they never
 * disagree.
 *
 * Honesty rule (B3): replay shows real detections and FRP values only.
 * Historical Risk Scores are NOT recomputed (the stored baseline math is
 * defined against today's clock); the score panel explicitly labels its
 * value "Today's assessment" during replay. No invented history.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FirmsHotspot } from "./firms";
import type { DetectionEvent } from "./types";

/** Replay transport state — one instance shared by every replayed surface. */
export interface ReplayState {
  /** Play/pause. Inactive when no facility is scoped. */
  playing: boolean;
  /** Current detection index into the ASCENDING (oldest-first) replay list. */
  index: number;
  /** The detection being shown right now (ascending order), if any. */
  current: FirmsHotspot | null;
  /** All real detections in the replay, oldest-first. */
  sequence: FirmsHotspot[];
  /** ISO date (YYYY-MM-DD) of the current step — the map filter value. */
  currentDate: string | null;
  /** "3 / 14" style progress label, or null when not scoped. */
  label: string | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  stepTo: (i: number) => void;
  /** Leave replay — clears the current step and stops the clock. */
  exit: () => void;
  /** True while replay is scoped to a facility (even when paused at start). */
  active: boolean;
}

const REPLAY_STEP_MS = 900;

/**
 * Build the facility's replay sequence from the FULL hotspot set: every
 * real detection within `radiusKm` of the facility, oldest-first, deduped
 * per acquisition timestamp (sensor passes see multiple pixels at once).
 * Returns null when the facility is unknown — replay never activates.
 */
export function buildReplaySequence(
  hotspots: FirmsHotspot[],
  facility: { id: string; lat: number; lng: number } | null,
  radiusKm = 5,
): FirmsHotspot[] | null {
  if (!facility) return null;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const km = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  const seen = new Set<string>();
  const seq = hotspots
    .filter((h) => km(facility.lat, facility.lng, h.latitude, h.longitude) <= radiusKm)
    .sort((a, b) =>
      a.acqDate < b.acqDate
        ? -1
        : a.acqDate > b.acqDate
          ? 1
          : a.acqTime.localeCompare(b.acqTime),
    )
    .filter((h) => {
      const key = `${h.acqDate}T${h.acqTime}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return seq;
}

/**
 * Map replay state → incident-timeline highlight (Track A2 ↔ B).
 *
 * The timeline renders the backend's `narrative.timeline` NEWEST-first
 * (index 0 = newest) and only its first 12 events; replay counts UP from
 * the oldest. This returns the timeline index whose acquisition timestamp
 * matches the current replay step, or null when replay is inactive.
 */
export function replayActiveEventIndex(
  timeline: DetectionEvent[] | undefined,
  replay: { active: boolean; current: FirmsHotspot | null } | null,
): number | null {
  if (!replay?.active || !replay.current || !timeline?.length) return null;
  const stamp = `${replay.current.acqDate} ${replay.current.acqTime.padStart(4, "0").slice(0, 2)}:${replay.current.acqTime.padStart(4, "0").slice(2, 4)}`;
  const idx = timeline.findIndex((ev) => ev.time === stamp);
  return idx >= 0 ? idx : null;
}

/**
 * The shared replay controller. Feed it the FULL hotspot set + the selected
 * facility; it owns the clock. `sequence` is memoised on facility + data so
 * the interval callback never restarts on unrelated re-renders.
 */
export function useReplay(
  hotspots: FirmsHotspot[],
  facility: { id: string; lat: number; lng: number } | null,
  radiusKm = 5,
): ReplayState {
  const sequence = useMemo(
    () => buildReplaySequence(hotspots, facility, radiusKm) ?? [],
    [hotspots, facility, radiusKm],
  );

  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState<number | null>(null);
  const indexRef = useRef<number | null>(null);
  indexRef.current = index;

  // Facility or data changed → restart cleanly (replay is facility-scoped).
  const facilityId = facility?.id ?? null;
  useEffect(() => {
    setPlaying(false);
    setIndex(null);
  }, [facilityId, sequence.length]);

  // Auto-advance: one shared clock, advancing the ASCENDING index.
  useEffect(() => {
    if (!playing || sequence.length === 0) return;
    const t = setInterval(() => {
      const next = (indexRef.current ?? -1) + 1;
      if (next >= sequence.length) {
        setPlaying(false);
        setIndex(null); // finished → back to "live" (all detections)
      } else {
        setIndex(next);
      }
    }, REPLAY_STEP_MS);
    return () => clearInterval(t);
  }, [playing, sequence]);

  const play = useCallback(() => {
    if (sequence.length === 0) return;
    setPlaying(true);
    // (Re)start from the oldest step when nothing is in progress or done.
    setIndex((cur) => (cur == null ? 0 : cur));
  }, [sequence.length]);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => {
    if (playing) {
      pause();
    } else {
      play();
    }
  }, [playing, pause, play]);

  const stepTo = useCallback(
    (i: number) => {
      if (sequence.length === 0) return;
      const clamped = Math.max(0, Math.min(i, sequence.length - 1));
      setIndex(clamped);
      setPlaying(false);
    },
    [sequence.length],
  );

  const exit = useCallback(() => {
    setPlaying(false);
    setIndex(null);
  }, []);

  const current = index != null ? sequence[index] ?? null : null;

  return {
    playing,
    index: index ?? -1,
    current,
    sequence,
    currentDate: current?.acqDate ?? null,
    label: sequence.length > 0 && index != null ? `${index + 1} / ${sequence.length}` : null,
    play,
    pause,
    toggle,
    stepTo,
    exit,
    active: sequence.length > 0,
  };
}

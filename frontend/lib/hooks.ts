"use client";

/**
 * PYROSENSE — SWR data hooks (§7).
 *
 * All client fetching goes through SWR with stale-while-revalidate, now
 * pointed at the STANDALONE BACKEND (lib/api.ts) instead of internal Next.js
 * routes. The backend computes every classification; the browser renders.
 * FIRMS polls every 5 minutes (its NRT cadence); facilities revalidate
 * gently since the OSM catalogue is ingested, not live. Map-driven fetches
 * are keyed by a *debounced* viewport string (the map never refetches per pan).
 */

import useSWR, { SWRConfiguration } from "swr";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseFirmsCsv } from "./firms";
import { fetchAnalyses, fetchCommand, fetchFirmsCsv, postChat, type ChatHistoryTurn } from "./api";
import { fetchMlHotspots, type MlHotspotSummaryDto, type MlHotspotsResponseDto } from "./mlApi";
import type { Facility, FacilityAnalysis, CommandView, ChatMessage } from "./types";
import type { FacilityAnalysisDto, CommandViewDto } from "./api";
import { BBox, bboxToString } from "./regions";

/* ------------------------------------------------------------------ */
/* debounced key helper — map-pan re-fetch throttling (§5)             */
/* ------------------------------------------------------------------ */

/**
 * Debounce a fast-changing value (e.g. map viewport) so the SWR key only
 * settles ≥ `delayMs` after movement stops. Keeps previous value while
 * waiting so SWR treats it as "no change" rather than clearing data.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** DTO → domain Facility (narrowing the type string to the union). */
function toFacility(f: {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  source: string;
}): Facility {
  return {
    id: f.id,
    name: f.name,
    type: f.type as Facility["type"],
    lat: f.lat,
    lng: f.lng,
    source: (f.source === "user_dataset" ? "user_dataset" : "osm") as Facility["source"],
  };
}

/** DTO → the FacilityAnalysis shape the UI already consumes. */
function toAnalysis(a: FacilityAnalysisDto): FacilityAnalysis {
  return {
    facility: toFacility(a.facility),
    status: a.status,
    riskScore: a.riskScore,
    riskScoreProvenance: a.riskScoreProvenance,
    riskScoreComputedAt: a.riskScoreComputedAt,
    riskScoreLive: a.riskScoreLive,
    latestFrp: a.latestFrp,
    nearestKm: a.nearestKm,
    detectionCount: a.detectionCount,
    liveMeanFrp: a.liveMeanFrp,
    baselineMeanFrp: a.baselineMeanFrp,
    predictedTag: a.predictedTag,
    liveConfidenceSplit: a.liveConfidenceSplit,
  };
}

/* ------------------------------------------------------------------ */
/* analyses — backend-computed classification (status/score)            */
/* ------------------------------------------------------------------ */

/** Analyses recompute after each backend refresh cycle (15 min). */
const ANALYSES_REFRESH_INTERVAL = 5 * 60 * 1000;

export function useAnalyses(
  bboxes: BBox[],
  options?: SWRConfiguration,
): {
  analyses: FacilityAnalysis[];
  error: boolean;
  isValidating: boolean;
  isLoading: boolean;
} {
  const key = useMemo(
    () =>
      bboxes.length > 0
        ? (["analyses", ...bboxes.map(bboxToString)] as const)
        : null,
    [bboxes],
  );

  const { data, error, isValidating, isLoading } = useSWR<{ analyses: FacilityAnalysis[] }>(
    key,
    async ([, ...bboxesStr]: readonly [string, ...string[]]) => {
      const results = await Promise.all(bboxesStr.map((b) => fetchAnalyses(b)));
      const seen = new Set<string>();
      const analyses = results
        .flatMap((r) => r.analyses)
        .filter((a) => (seen.has(a.facility.id) ? false : (seen.add(a.facility.id), true)))
        .map(toAnalysis);
      return { analyses };
    },
    {
      refreshInterval: ANALYSES_REFRESH_INTERVAL,
      revalidateOnFocus: true,
      keepPreviousData: true,
      // Tab-refocus should not trigger an extra refetch on top of the poll
      // cycle — SWR dedupes all requests within the refresh window.
      dedupingInterval: ANALYSES_REFRESH_INTERVAL,
      ...options,
    },
  );

  return {
    analyses: data?.analyses ?? [],
    error: !!error,
    isValidating,
    isLoading,
  };
}

/* ------------------------------------------------------------------ */
/* FIRMS — stored detections as FIRMS-format CSV via the backend        */
/* ------------------------------------------------------------------ */

/** FIRMS NRT refreshes ~3-hourly; 5-minute polling is a sane live cadence. */
export const FIRMS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function useFirms(
  bboxes: BBox[],
  options?: SWRConfiguration,
): {
  hotspots: ReturnType<typeof parseFirmsCsv>;
  error: boolean;
  isValidating: boolean;
  isLoading: boolean;
} {
  const key = useMemo(
    () =>
      bboxes.length > 0
        ? (["firms", ...bboxes.map((b) => `${bboxToString(b)}|10`)] as const)
        : null,
    [bboxes],
  );

  const { data, error, isValidating, isLoading } = useSWR(
    key,
    async ([, ...bboxRanges]: readonly [string, ...string[]]) => {
      const results = await Promise.all(
        bboxRanges.map((br) => {
          const [bbox, days] = br.split("|");
          return fetchFirmsCsv(bbox!, Number(days) || 10);
        }),
      );
      return results.flatMap((csv) => parseFirmsCsv(csv));
    },
    {
      refreshInterval: FIRMS_REFRESH_INTERVAL_MS,
      revalidateOnFocus: true,
      keepPreviousData: true, // never blank out during a background refresh
      // The FIRMS payload is the app's biggest response — tab refocus must
      // dedupe into the existing poll cadence instead of refetching it.
      dedupingInterval: FIRMS_REFRESH_INTERVAL_MS,
      ...options,
    },
  );

  return {
    hotspots: data ?? [],
    error: !!error,
    isValidating,
    isLoading,
  };
}

/* ------------------------------------------------------------------ */
/* command view — top-level counters (always visible)                   */
/* ------------------------------------------------------------------ */

const COMMAND_REFRESH_INTERVAL = 30 * 1000; // 30 seconds

export function useCommand(options?: SWRConfiguration): {
  command: CommandView | null;
  error: boolean;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<CommandViewDto>(
    "command",
    () => fetchCommand(),
    {
      refreshInterval: COMMAND_REFRESH_INTERVAL,
      revalidateOnFocus: true,
      keepPreviousData: true,
      ...options,
    },
  );

  return {
    command: data ?? null,
    error: !!error,
    isLoading,
  };
}

/* ------------------------------------------------------------------ */
/* ML hotspots — pyrosense_ml catalogue via the backend proxy            */
/* ------------------------------------------------------------------ */

/**
 * Historical + live model-predicted hotspots from pyrosense_ml, fetched
 * through the backend's pass-through proxy (lib/mlApi.ts). Gentle
 * revalidation: the historical seed is static; live predicts accumulate.
 */
const ML_HOTSPOTS_REFRESH_INTERVAL = 5 * 60 * 1000;

export function useMlHotspots(
  source: "historical" | "live" | "all" = "all",
  options?: SWRConfiguration,
): {
  hotspots: MlHotspotSummaryDto[];
  error: boolean;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<MlHotspotsResponseDto>(
    ["ml-hotspots", source],
    () =>
      fetchMlHotspots(source === "all" ? undefined : { source }),
    {
      refreshInterval: ML_HOTSPOTS_REFRESH_INTERVAL,
      revalidateOnFocus: true,
      keepPreviousData: true,
      ...options,
    },
  );

  return {
    hotspots: data?.hotspots ?? [],
    error: !!error,
    isLoading,
  };
}

/* ------------------------------------------------------------------ */
/* chatbot — stateless conversational interface                        */
/* ------------------------------------------------------------------ */

export function useChat(facilityId?: string): {
  messages: ChatMessage[];
  sendMessage: (text: string) => Promise<void>;
  isLoading: boolean;
  clearMessages: () => void;
} {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = {
        role: "user",
        text,
        timestamp: Date.now(),
      };
      // Snapshot prior turns BEFORE appending, so the backend gets the
      // conversation so far (last 8 turns is plenty for context).
      const history: ChatHistoryTurn[] = messages
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.text }));
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      try {
        const result = await postChat(text, facilityId, history);
        const assistantMsg: ChatMessage = {
          role: "assistant",
          text: result.reply,
          provider: result.provider,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } catch {
        const errorMsg: ChatMessage = {
          role: "assistant",
          text: "Sorry, I couldn't process your request. Please try again.",
          provider: "fallback",
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setIsLoading(false);
      }
    },
    [facilityId, messages],
  );

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, sendMessage, isLoading, clearMessages };
}


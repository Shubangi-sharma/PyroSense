"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Search, User, CornerDownLeft, AlertTriangle, Loader2 } from "lucide-react";
import BrandMark from "@/components/BrandMark";
import { FacilityAnalysis, STATUS_META, statusColorHex } from "@/lib/types";
import { StatusGlyph } from "@/lib/status";
import { useAnalyses } from "@/lib/hooks";
import { REGION_BBOXES } from "@/lib/regions";
import clsx from "clsx";

/** Search result row — status dot + name + type chip + risk tag. */
function SearchRow({
  analysis,
  active,
  onSelect,
  onHover,
  indexRef,
}: {
  analysis: FacilityAnalysis;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
  indexRef: React.MutableRefObject<number>;
}) {
  const hex = statusColorHex(analysis.status);
  return (
    <button
      type="button"
      ref={(el) => {
        if (active && el && indexRef.current >= 0) {
          el.scrollIntoView({ block: "nearest" });
        }
      }}
      onClick={onSelect}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      className={clsx(
        "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-150",
        active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
      )}
    >
      <StatusGlyph status={analysis.status} size={9} className="flex-shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-primary">{analysis.facility.name}</span>
        <span className="block truncate font-mono text-[10px] text-text-tertiary">
          {analysis.facility.type} · risk {analysis.riskScore} · {analysis.detectionCount} det
        </span>
      </span>
      <span
        className="flex-shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider"
        style={{ backgroundColor: `${hex}22`, color: hex }}
      >
        {STATUS_META[analysis.status].tag}
      </span>
    </button>
  );
}

export default function TopBar({ unreadCritical }: { unreadCritical: number }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [focused, setFocused] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeIdxRef = useRef(0);
  activeIdxRef.current = activeIdx;

  const { analyses, isLoading } = useAnalyses(REGION_BBOXES.india);

  const criticalFacilities = useMemo(
    () => analyses.filter((a) => a.status === "critical").slice(0, 6),
    [analyses],
  );

  const suspiciousCount = useMemo(() => analyses.filter((a) => a.status === "suspicious").length, [analyses]);
  const watchCount = useMemo(() => analyses.filter((a) => a.status === "watch").length, [analyses]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return analyses
      .filter((a) => `${a.facility.name} ${a.facility.type}`.toLowerCase().includes(q))
      .slice(0, 6);
  }, [analyses, query]);

  const open = focused && query.trim().length >= 2;
  const selectResult = (a: FacilityAnalysis) => {
    router.push(`/facilities/${a.facility.id}`);
    setQuery("");
    setFocused(false);
    inputRef.current?.blur();
  };

  // close menus on outside click / Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setBellOpen(false);
        setAvatarOpen(false);
        setFocused(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setBellOpen(false);
        setAvatarOpen(false);
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // ⌘K / Ctrl+K focuses search from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = results[activeIdx] ?? results[0];
      if (a) selectResult(a);
    }
  };

  return (
    <header
      ref={rootRef}
      className="relative z-[1200] flex h-[56px] flex-shrink-0 items-center gap-4 border-b border-white/[0.06] px-4"
      style={{
        background:
          "linear-gradient(180deg, rgba(12, 16, 21, 0.88) 0%, rgba(9, 12, 16, 0.78) 100%)",
        backdropFilter: "blur(20px) saturate(1.3)",
        WebkitBackdropFilter: "blur(20px) saturate(1.3)",
        boxShadow: "0 1px 0 rgba(91, 155, 213, 0.05)",
      }}
    >
      {/* brand - glyph optically centered with the wordmark */}
      <button
        type="button"
        onClick={() => router.push("/")}
        aria-label="PYROSENSE home"
        className="flex items-center gap-2 transition-opacity duration-200 hover:opacity-85"
      >
        <BrandMark size={24} />
        <span className="font-display text-base font-semibold tracking-[0.02em] text-text-primary">
          PYRO<span className="text-accent-primary">SENSE</span>
        </span>
      </button>

      {/* search - centered, ⌘K, arrow-key navigable */}
      <div className="relative mx-auto hidden w-full max-w-[540px] sm:block">
        <div
          className={clsx(
            "flex h-9 items-center gap-2 rounded-xl border px-3 transition-all duration-200",
            open
              ? "border-accent-primary/50 bg-bg-void/80 shadow-[0_0_0_3px_rgba(91,155,213,0.1)]"
              : "border-white/[0.07] bg-white/[0.03] hover:border-white/[0.14]",
          )}
        >
          <Search size={14} className="flex-shrink-0 text-text-tertiary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onFocus={() => setFocused(true)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search facilities…"
            aria-label="Search facilities"
            className="h-full w-full bg-transparent font-mono text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {isLoading && !analyses.length ? (
            <Loader2 size={12} className="flex-shrink-0 animate-spin text-text-tertiary" />
          ) : query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="flex-shrink-0 text-text-tertiary transition-colors hover:text-text-primary"
            >
              ×
            </button>
          ) : (
            <kbd className="hidden flex-shrink-0 items-center gap-0.5 rounded-md border border-white/[0.09] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-text-tertiary md:flex">
              ⌘K
            </kbd>
          )}
        </div>

        {/* results dropdown - map-glass, same language as the map chrome */}
        {open && (
          <div className="map-glass absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl">
            {results.length > 0 ? (
              <>
                <div className="border-b border-white/[0.06] px-3 py-1.5 font-mono text-[9px] uppercase tracking-widest text-text-tertiary">
                  {results.length} {results.length === 1 ? "facility" : "facilities"}
                </div>
                {results.map((a, i) => (
                  <SearchRow
                    key={a.facility.id}
                    analysis={a}
                    active={i === activeIdx}
                    onSelect={() => selectResult(a)}
                    onHover={() => setActiveIdx(i)}
                    indexRef={activeIdxRef}
                  />
                ))}
              </>
            ) : (
              <div className="px-4 py-4 text-center">
                <p className="text-xs text-text-secondary">No facilities match “{query.trim()}”</p>
                <p className="mt-1 font-mono text-[10px] text-text-tertiary">
                  Try a name fragment or a facility type
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* right cluster */}
      <div className="ml-auto flex items-center gap-2 sm:ml-0 sm:gap-3">
        {/* command counters - always visible */}
        <div className="hidden items-center gap-3 md:flex">
          {analyses.length > 0 ? (
            <>
              <span className="font-mono text-xs text-text-tertiary">
                LIVE · {analyses.length} sites
              </span>
              {unreadCritical > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-status-critical/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-status-critical ring-1 ring-status-critical/20">
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-status-critical" />
                  {unreadCritical} CRT
                </span>
              )}
              {suspiciousCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-status-suspicious/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-status-suspicious ring-1 ring-status-suspicious/20">
                  {suspiciousCount} SUS
                </span>
              )}
              {watchCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-status-watch/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-status-watch ring-1 ring-status-watch/20">
                  {watchCount} WTC
                </span>
              )}
            </>
          ) : (
            <span className="font-mono text-xs text-text-tertiary">
              connecting to live feeds…
            </span>
          )}
        </div>

        {/* bell - redesigned critical alerts dropdown */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setBellOpen((v) => !v);
              setAvatarOpen(false);
            }}
            aria-label={`Notifications - ${unreadCritical} unread critical`}
            aria-expanded={bellOpen}
            className={clsx(
              "relative flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-200",
              bellOpen
                ? "bg-white/[0.07] text-text-primary ring-1 ring-accent-primary/40"
                : "text-text-secondary hover:bg-white/[0.04] hover:text-text-primary",
            )}
          >
            <Bell size={17} />
            {unreadCritical > 0 && (
              <>
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-status-critical ring-2 ring-[#0B0E12] animate-pulse" />
              </>
            )}
          </button>

          {bellOpen && (
            <div className="map-glass absolute right-0 top-full z-50 mt-2 w-[360px] overflow-hidden rounded-xl">
              <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <AlertTriangle size={12} className="text-status-critical" />
                <span className="font-body text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                  Critical alerts
                </span>
                <span className="ml-auto font-mono text-[10px] text-text-tertiary">
                  from live FIRMS
                </span>
              </div>
              {criticalFacilities.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs text-text-secondary">
                    No critical facilities right now.
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-text-tertiary">
                    All monitored sites within baseline
                  </p>
                </div>
              ) : (
                criticalFacilities.map((a) => (
                  <button
                    key={a.facility.id}
                    type="button"
                    onClick={() => {
                      router.push(`/facilities/${a.facility.id}`);
                      setBellOpen(false);
                    }}
                    className="flex w-full items-center gap-3 border-b border-white/[0.05] px-4 py-3 text-left transition-colors duration-150 last:border-b-0 hover:bg-white/[0.04]"
                  >
                    <StatusGlyph status="critical" size={10} className="flex-shrink-0 animate-pulse-glow" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text-primary">
                        {a.facility.name}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-text-tertiary">
                        risk {a.riskScore} · {a.detectionCount} det ·{" "}
                        {a.latestFrp != null ? `${a.latestFrp.toFixed(0)} MW` : "n/a"}
                      </span>
                    </span>
                    <CornerDownLeft size={11} className="flex-shrink-0 text-text-tertiary" />
                  </button>
                ))
              )}
              <div className="border-t border-white/[0.06] px-4 py-2 text-center">
                <span className="font-mono text-[9px] uppercase tracking-widest text-text-tertiary">
                  Thresholds from the site&apos;s own baseline
                </span>
              </div>
            </div>
          )}
        </div>

        {/* avatar - account stub */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setAvatarOpen((v) => !v);
              setBellOpen(false);
            }}
            aria-label="Account menu"
            aria-expanded={avatarOpen}
            className={clsx(
              "flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-all duration-200",
              avatarOpen
                ? "text-text-primary ring-1 ring-accent-primary/40"
                : "hover:text-text-primary",
            )}
            style={{
              background:
                "linear-gradient(135deg, rgba(91,155,213,0.14) 0%, rgba(79,179,179,0.1) 100%)",
              border: "1px solid rgba(91,155,213,0.2)",
            }}
          >
            <User size={14} />
          </button>

          {avatarOpen && (
            <div className="map-glass absolute right-0 top-full z-50 mt-2 w-[220px] overflow-hidden rounded-xl">
              <div className="border-b border-white/[0.06] px-4 py-3">
                <p className="text-sm text-text-primary">Station Operator</p>
                <p className="font-mono text-[10px] text-text-tertiary">
                  ops@pyrosense.demo
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  router.push("/settings");
                  setAvatarOpen(false);
                }}
                className="block w-full px-4 py-3 text-left text-sm text-text-secondary transition-colors duration-150 hover:bg-white/[0.04] hover:text-text-primary"
              >
                Settings
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

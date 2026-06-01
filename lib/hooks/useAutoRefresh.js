"use client";
/**
 * useAutoRefresh — visibility-aware automatic data refresh hook.
 *
 * Behaviours
 * ───────────
 * • Calls refresh(false) once on mount (full load).
 * • Calls refresh(true)  on the given interval while the tab is visible.
 * • Calls refresh(true)  immediately when the tab becomes visible again
 *   (document.visibilitychange) or the window regains focus — catching up
 *   on anything that changed while the user was away.
 * • Skips the timed tick while the tab is hidden to avoid wasting requests.
 * • Prevents concurrent refresh calls via a running guard.
 *
 * Usage
 * ─────
 *   useAutoRefresh(refreshData, 15_000);  // refresh every 15 s
 */

import { useEffect, useRef, useCallback } from "react";

export function useAutoRefresh(refresh, intervalMs = 15_000) {
  const timerRef   = useRef(null);
  const runningRef = useRef(false);

  // Schedule the next timed tick
  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      if (!document.hidden && !runningRef.current) {
        runningRef.current = true;
        try { await refresh(true); } finally { runningRef.current = false; }
      }
      schedule();
    }, intervalMs);
  }, [refresh, intervalMs]);

  // Fire an immediate refresh (used by visibility/focus events)
  const refreshNow = useCallback(async () => {
    if (runningRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    runningRef.current = true;
    try { await refresh(true); } finally {
      runningRef.current = false;
      schedule(); // reschedule from now
    }
  }, [refresh, schedule]);

  useEffect(() => {
    // Initial full load
    refresh(false);
    schedule();

    const onVisibility = () => { if (!document.hidden) refreshNow(); };
    const onFocus      = () => refreshNow();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, schedule, refreshNow]);
}

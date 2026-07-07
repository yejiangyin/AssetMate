import { useCallback, useEffect, useRef, useState } from "react";
import { searchSecuritiesLive, type LiveResult, type Market } from "../services/securitiesApi";

export function useSecuritySearch(value: string, marketFilter?: Market) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<LiveResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchSeqRef = useRef(0);

  const doSearch = useCallback(async (query: string, filter?: Market) => {
    const seq = ++searchSeqRef.current;
    if (!query.trim()) {
      setHits([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const results = await searchSecuritiesLive(query, filter);
      if (seq !== searchSeqRef.current) return;
      setHits(results);
      setOpen(results.length > 0);
      setApiOk(results.length ? results[0]?.source === "live" : false);
    } catch {
      if (seq !== searchSeqRef.current) return;
      setHits([]);
      setApiOk(false);
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  }, []);

  const scheduleSearch = useCallback((query: string, filter = marketFilter) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(query, filter), 350);
  }, [doSearch, marketFilter]);

  useEffect(() => {
    if (!value.trim()) {
      searchSeqRef.current += 1;
      setHits([]);
      setOpen(false);
      setLoading(false);
      return;
    }
    void doSearch(value, marketFilter);
    // Typing is debounced through scheduleSearch; this effect only resyncs
    // when the market scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doSearch, marketFilter]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return {
    apiOk,
    hits,
    loading,
    open,
    setOpen,
    scheduleSearch,
  };
}

import { BarChart3, BrainCircuit, Microscope } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useApp } from "../context/AppContext";
import { Backtest, type BacktestView } from "./Backtest";
import { AIResearchPanel } from "./research/AIResearchPanel";
import type { BacktestResearchContext, BacktestSeed } from "../research/types";

type ResearchTab = "ai" | "backtest" | "compare";

function tabFromQuery(value: string | null): ResearchTab {
  return value === "backtest" || value === "compare" ? value : "ai";
}

export function ResearchHub() {
  const { language } = useApp();
  const isEn = language === "en";
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState<ResearchTab>(() => tabFromQuery(searchParams.get("tab")));
  const querySeed = useMemo<BacktestSeed | null>(() => {
    const symbol = searchParams.get("symbol")?.trim();
    if (!symbol) return null;
    return {
      symbol,
      name: searchParams.get("name")?.trim() || symbol,
      market: searchParams.get("market")?.trim() || "US",
      assetType: searchParams.get("assetType")?.trim() || "stock",
    };
  }, [searchParams]);
  const [backtestSeed, setBacktestSeed] = useState<BacktestSeed | null>(querySeed);
  const [backtestContext, setBacktestContext] = useState<BacktestResearchContext | null>(null);

  useEffect(() => {
    setTabState(tabFromQuery(searchParams.get("tab")));
  }, [searchParams]);

  const setTab = (next: ResearchTab) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  const startBacktest = (seed: BacktestSeed) => {
    setBacktestSeed(seed);
    setTab("backtest");
  };

  const interpretBacktest = (context: BacktestResearchContext) => {
    setBacktestContext(context);
    setTab("ai");
  };

  const backtestView: BacktestView = tab === "compare" ? "compare" : "backtest";
  const tabs: Array<{ id: ResearchTab; label: string; icon: typeof BrainCircuit }> = [
    { id: "ai", label: isEn ? "AI Research" : "AI 研究", icon: BrainCircuit },
    { id: "backtest", label: isEn ? "Backtest" : "策略回测", icon: BarChart3 },
    { id: "compare", label: isEn ? "Compare" : "方案对比", icon: Microscope },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg">
      <header className="shrink-0 border-b border-app-border bg-app-bg px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(79,156,249,0.12)] text-app-accent"><Microscope size={16} /></span>
          <div className="min-w-0">
            <h1 className="text-[15px] font-bold leading-5 text-tp">{isEn ? "Research Center" : "投研中心"}</h1>
            <p className="truncate text-[11px] text-tmi">{isEn ? "Evidence, scenarios and strategy validation" : "证据研究、情景推演与策略验证"}</p>
          </div>
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-1 rounded-xl border border-app-border bg-app-card p-1" role="tablist" aria-label={isEn ? "Research center sections" : "投研中心页签"}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12px] font-semibold transition-colors ${tab === id ? "bg-[rgba(79,156,249,0.13)] text-app-accent" : "text-tm"}`}
            >
              <Icon size={13} />{label}
            </button>
          ))}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="h-full" style={{ display: tab === "ai" ? "block" : "none" }}>
          <AIResearchPanel
            initialSeed={backtestSeed}
            backtestContext={backtestContext}
            onBacktest={startBacktest}
            onClearBacktestContext={() => setBacktestContext(null)}
          />
        </div>
        <div className="h-full" style={{ display: tab === "ai" ? "none" : "block" }}>
          <Backtest
            embedded
            view={backtestView}
            onViewChange={(view) => setTab(view)}
            initialSeed={backtestSeed}
            onInterpret={interpretBacktest}
          />
        </div>
      </main>
    </div>
  );
}

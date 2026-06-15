/* ─── shared types ────────────────────────────────────── */
export type Group = {
  id:      string;
  name:    string;
  color:   string;
  sort:    number;
  visible: boolean;
};

export type Holding = {
  id:           string;
  groupId:      string;          // group this holding belongs to (empty = ungrouped)
  symbol:       string;
  name:         string;
  market:       "US" | "HK" | "A" | "JP" | "FUND" | "CRYPTO" | "BOND" | "GOLD";
  assetType:    "stock" | "etf" | "fund" | "crypto" | "cash" | "bond";
  quantity:     number;
  costPrice:    number;
  currentPrice: number;
  currency:     string;
  marketValue:  number;
  todayPnl:     number;
  todayPnlRate: number;
  totalPnl:     number;
  totalPnlRate: number;
  cashDividendTotal?: number;
  dividendReinvest?: boolean | null;
  autoCorporateActionSince?: string;
  corporateActions?: Array<{
    id: string;
    type: "cash_dividend" | "share_dividend" | "split";
    date: string;
    amount?: number;
    shares?: number;
    ratio?: number;
    price?: number;
    recordDate?: string;
    exDate?: string;
    payDate?: string;
    announcementDate?: string;
    source?: string;
    note?: string;
    description?: string;
  }>;
  tradeStatus:  "normal" | "suspended" | "fund_limit" | "buy_disabled";
  tradeStatusNote?: string;
  autoTradeStatus?: "normal" | "suspended" | "fund_limit" | "buy_disabled" | null;
  autoTradeStatusNote?: string;
  autoTradeStatusSource?: string | null;
  fundBuyConfirmDays?: number;
  priceDate?:    string;
  fundNavHistory?:        Array<{ date: string; nav: number }>;
  estimatedNav?:           number;
  estimatedChangePercent?: number;
  updatedAt:    string;
};

export type MarketIndex = {
  id:           string;
  name:         string;
  market:       string;
  currentValue: number;
  changeRate:   number;
  changeAmount: number;
  data:         { v: number }[];
};

/* ─── groups ─────────────────────────────────────────── */
export const groups: Group[] = [
  { id: "group_oversea",     name: "海外资产", color: "#4F9CF9", sort: 1, visible: true },
  { id: "group_astock",      name: "A股资产",  color: "#F24E4E", sort: 2, visible: true },
  { id: "group_crypto",      name: "加密资产", color: "#F59E0B", sort: 3, visible: true },
  { id: "group_conservative",name: "稳健资产", color: "#31D08B", sort: 4, visible: true },
];

/* ─── holdings ───────────────────────────────────────── */
export const holdings: Holding[] = [];

/* ─── market indices metadata placeholder ────────────── */
export const marketIndices: MarketIndex[] = [];

/* ─── 30-day estimated portfolio trend ───────────────── */
export const assetSnapshot30Days: Array<{ date: string; asset: number; pnl: number }> = [];

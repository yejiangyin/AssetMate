/* ─── shared types ────────────────────────────────────── */
export type Group = {
  id:      string;
  name:    string;
  color:   string;
  sort:    number;
  visible: boolean;
};

export type TransactionCostProfile = {
  buyFeeRate?: number;
  sellFeeRate?: number;
  minimumFee?: number;
  buyTaxRate?: number;
  sellTaxRate?: number;
  dividendTaxRate?: number;
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
  transactionCostProfile?: TransactionCostProfile;
  dividendReinvest?: boolean | null;
  autoCorporateActionSince?: string;
  corporateActions?: Array<{
    id: string;
    type: "cash_dividend" | "dividend_reinvest" | "share_dividend" | "split" | "interest" | "bond_coupon" | "fee" | "tax";
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
    rateUsed?: number;
    minimumFeeUsed?: number;
    estimatedAmount?: number;
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

export type ClosedHolding = {
  id:              string;
  sourceHoldingId: string;
  groupId:         string;
  symbol:          string;
  name:            string;
  market:          Holding["market"];
  assetType:       Holding["assetType"];
  quantity:        number;
  costPrice:       number;
  closePrice:      number;
  costBasis:       number;
  proceeds:        number;
  transactionFee?: number;
  transactionTax?: number;
  realizedPnl:     number;
  realizedReturn:  number;
  cashDividendTotal: number;
  /** True when dividends were reinvested (红利再投) instead of paid as cash. */
  dividendReinvest?: boolean;
  currency:        string;
  openedAt:        string;
  closedAt:        string;
  /** True when only part of the position was sold (减仓), false for full close. */
  isPartial?:      boolean;
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
export const holdings: Holding[] = [
  {
    id: "demo_holding_aapl",
    groupId: "group_oversea",
    symbol: "AAPL",
    name: "苹果",
    market: "US",
    assetType: "stock",
    quantity: 20,
    costPrice: 205,
    currentPrice: 289.36,
    currency: "USD",
    marketValue: 5787.2,
    todayPnl: 95.4,
    todayPnlRate: 0.0168,
    totalPnl: 1687.2,
    totalPnlRate: 0.4115,
    cashDividendTotal: 18.4,
    tradeStatus: "normal",
    updatedAt: "2026-07-01T02:00:00.000Z",
  },
  {
    id: "demo_holding_510300",
    groupId: "group_astock",
    symbol: "510300",
    name: "沪深300ETF",
    market: "A",
    assetType: "etf",
    quantity: 1000,
    costPrice: 3.85,
    currentPrice: 4.12,
    currency: "CNY",
    marketValue: 4120,
    todayPnl: -12,
    todayPnlRate: -0.0029,
    totalPnl: 270,
    totalPnlRate: 0.0701,
    tradeStatus: "normal",
    updatedAt: "2026-07-01T02:00:00.000Z",
  },
  {
    id: "demo_holding_btc",
    groupId: "group_crypto",
    symbol: "BTC-USD",
    name: "Bitcoin",
    market: "CRYPTO",
    assetType: "crypto",
    quantity: 0.08,
    costPrice: 65000,
    currentPrice: 108000,
    currency: "USD",
    marketValue: 8640,
    todayPnl: 210,
    todayPnlRate: 0.0249,
    totalPnl: 3440,
    totalPnlRate: 0.6615,
    tradeStatus: "normal",
    updatedAt: "2026-07-01T02:00:00.000Z",
  },
  {
    id: "demo_holding_006479",
    groupId: "group_conservative",
    symbol: "006479",
    name: "广发纳斯达克100ETF联接人民币(QDII)C",
    market: "FUND",
    assetType: "fund",
    quantity: 2200,
    costPrice: 2.18,
    currentPrice: 2.46,
    currency: "CNY",
    marketValue: 5412,
    todayPnl: 8.8,
    todayPnlRate: 0.0016,
    totalPnl: 616,
    totalPnlRate: 0.1284,
    dividendReinvest: true,
    fundBuyConfirmDays: 2,
    fundNavHistory: [
      { date: "2026-06-25", nav: 2.421 },
      { date: "2026-06-26", nav: 2.433 },
      { date: "2026-06-29", nav: 2.448 },
      { date: "2026-06-30", nav: 2.452 },
      { date: "2026-07-01", nav: 2.46 },
    ],
    tradeStatus: "normal",
    updatedAt: "2026-07-01T02:00:00.000Z",
  },
];

export const closedHoldings: ClosedHolding[] = [
  {
    id: "demo_closed_msft",
    sourceHoldingId: "demo_holding_msft",
    groupId: "group_oversea",
    symbol: "MSFT",
    name: "微软",
    market: "US",
    assetType: "stock",
    quantity: 12,
    costPrice: 330,
    closePrice: 455,
    costBasis: 3960,
    proceeds: 5460,
    realizedPnl: 1524,
    realizedReturn: 0.3848,
    cashDividendTotal: 24,
    currency: "USD",
    openedAt: "2024-03-12",
    closedAt: "2026-05-20",
  },
  {
    id: "demo_closed_000001",
    sourceHoldingId: "demo_holding_000001",
    groupId: "group_astock",
    symbol: "000001",
    name: "平安银行",
    market: "A",
    assetType: "stock",
    quantity: 800,
    costPrice: 12.6,
    closePrice: 11.2,
    costBasis: 10080,
    proceeds: 8960,
    realizedPnl: -1120,
    realizedReturn: -0.1111,
    cashDividendTotal: 0,
    currency: "CNY",
    openedAt: "2025-01-08",
    closedAt: "2026-02-14",
  },
];

/* ─── market indices metadata placeholder ────────────── */
export const marketIndices: MarketIndex[] = [];

/* ─── 30-day estimated portfolio trend ───────────────── */
export const assetSnapshot30Days: Array<{ date: string; asset: number; pnl: number }> = [];

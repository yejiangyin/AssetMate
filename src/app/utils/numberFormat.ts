export function currencySymbol(currency: string) {
  if (currency === "CNY") return "¥";
  if (currency === "HKD") return "HK$";
  if (currency === "JPY") return "¥";
  if (currency === "USD" || currency === "USDT" || currency === "USDC") return "$";
  if (currency === "EUR") return "€";
  return currency ? `${currency} ` : "";
}

export function formatExactNumber(value: number | undefined | null, maxDecimals = 12, minDecimals = 0, locale?: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString(locale, {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
    useGrouping: true,
  });
}

export function formatFixedNumber(value: number | undefined | null, decimals = 3, locale?: string) {
  return formatExactNumber(value, decimals, decimals, locale);
}

export function formatExactMoney(value: number | undefined | null, currency = "CNY", decimals = 3, locale?: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${currencySymbol(currency)}${formatFixedNumber(value, decimals, locale)}`;
}

export function formatSignedExactMoney(value: number, currency = "CNY", decimals = 3) {
  const sign = value < 0 || Object.is(value, -0) ? "-" : "+";
  return `${sign}${formatExactMoney(Math.abs(value), currency, decimals)}`;
}

export function formatPercent(value: number, decimals = 4, locale?: string) {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "+";
  return `${sign}${(Math.abs(value) * 100).toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

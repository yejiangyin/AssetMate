import { memo, useId, type ReactNode } from "react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { formatFixedNumber } from "../utils/numberFormat";

type SparklineDatum = {
  v?: number;
  [key: string]: unknown;
};

interface SparklineChartProps {
  data: SparklineDatum[];
  color: string;
  height?: number;
  tooltip?: (point: SparklineDatum) => ReactNode;
}

export const SparklineChart = memo(function SparklineChart({ data, color, height = 36, tooltip }: SparklineChartProps) {
  const uid = useId().replace(/:/g, "");
  const gradId = `grad-${uid}`;
  const safeData = data
    .map((point) => ({
      ...point,
      v: typeof point.v === "number" && Number.isFinite(point.v) ? point.v : undefined,
    }))
    .filter((point) => point.v != null);
  if (safeData.length === 0) {
    return <div style={{ width: "100%", height }} />;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={safeData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Area
          type="monotone"
          dataKey="v"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#${gradId})`}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
        <Tooltip
          content={({ active, payload }) =>
            active && payload && payload.length ? (
              <div
                style={{
                  background: "var(--bg-card, rgba(15,23,42,0.95))",
                  border: "1px solid var(--border, rgba(255,255,255,0.1))",
                  borderRadius: 6,
                  padding: "3px 8px",
                  fontSize: 11,
                  color: "var(--text-primary, #F1F5F9)",
                  pointerEvents: "none",
                }}
              >
                {tooltip
                  ? tooltip(payload[0]?.payload as SparklineDatum)
                  : formatFixedNumber(Number(payload[0]?.value))}
              </div>
            ) : null
          }
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});

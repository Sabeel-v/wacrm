"use client";

import { useState } from "react";
import { Calendar, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PieSlice {
  label: string;
  value: number;
  color: string;
}

function getDonutArc(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number
): string {
  const x1 = cx + rOuter * Math.cos(startAngle);
  const y1 = cy + rOuter * Math.sin(startAngle);
  const x2 = cx + rOuter * Math.cos(endAngle);
  const y2 = cy + rOuter * Math.sin(endAngle);

  const x3 = cx + rInner * Math.cos(endAngle);
  const y3 = cy + rInner * Math.sin(endAngle);
  const x4 = cx + rInner * Math.cos(startAngle);
  const y4 = cy + rInner * Math.sin(startAngle);

  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4} Z`;
}

function getPieArc(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number
): string {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);

  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

function CircleChart({
  slices,
  isDonut = false,
  size = 170,
}: {
  slices: PieSlice[];
  isDonut?: boolean;
  size?: number;
}) {
  const [hoveredSlice, setHoveredSlice] = useState<string | null>(null);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.44;
  const rInner = isDonut ? size * 0.28 : 0;

  let currentAngle = -Math.PI / 2;

  const paths = slices.map((slice) => {
    const fraction = total > 0 ? slice.value / total : 0;
    const sweepAngle = fraction * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + sweepAngle;
    currentAngle = endAngle;

    const isFull = sweepAngle >= 2 * Math.PI - 0.001;

    let path = "";
    if (isDonut) {
      if (isFull) {
        const mid = startAngle + Math.PI;
        path = `${getDonutArc(cx, cy, rOuter, rInner, startAngle, mid)} ${getDonutArc(cx, cy, rOuter, rInner, mid, endAngle)}`;
      } else {
        path = getDonutArc(cx, cy, rOuter, rInner, startAngle, endAngle);
      }
    } else {
      if (isFull) {
        const mid = startAngle + Math.PI;
        path = `${getPieArc(cx, cy, rOuter, startAngle, mid)} ${getPieArc(cx, cy, rOuter, mid, endAngle)}`;
      } else {
        path = getPieArc(cx, cy, rOuter, startAngle, endAngle);
      }
    }

    return {
      slice,
      path,
      fraction,
    };
  });

  return (
    <div className="relative inline-flex flex-col items-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="overflow-visible transition-transform duration-200 hover:scale-105"
      >
        {paths.map(({ slice, path, fraction }, i) => (
          <path
            key={i}
            d={path}
            fill={slice.color}
            stroke="var(--card)"
            strokeWidth={1}
            className="cursor-pointer transition-opacity duration-150 hover:opacity-85"
            onMouseEnter={() =>
              setHoveredSlice(`${slice.label} (${(fraction * 100).toFixed(1)}%)`)
            }
            onMouseLeave={() => setHoveredSlice(null)}
          >
            <title>{`${slice.label}: ${(fraction * 100).toFixed(1)}%`}</title>
          </path>
        ))}
      </svg>
      {hoveredSlice && (
        <div className="pointer-events-none absolute -top-8 z-20 whitespace-nowrap rounded bg-foreground/90 px-2 py-0.5 text-[11px] font-medium text-background shadow-xs">
          {hoveredSlice}
        </div>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const [timeRange, setTimeRange] = useState("Last 30 Days");

  // Chart 1: New Leads (Donut)
  const newLeadsSlices: PieSlice[] = [
    { label: "Direct Web", value: 95.5, color: "#facc15" }, // Yellow/Gold
    { label: "WhatsApp Inbound", value: 1.5, color: "#e53935" }, // Red
    { label: "Chatbot", value: 1.5, color: "#00bcd4" }, // Cyan
    { label: "Other", value: 1.5, color: "#1e88e5" }, // Blue
  ];

  // Chart 2: IN-PROGRESS (Donut)
  const inProgressSlices: PieSlice[] = [
    { label: "Follow-up Needed", value: 36, color: "#1a237e" }, // Dark Navy
    { label: "Quotation Sent", value: 18, color: "#512da8" }, // Indigo / Purple
    { label: "Demo Scheduled", value: 15, color: "#c0ca33" }, // Olive / Lime
    { label: "Reviewing Proposal", value: 8, color: "#00acc1" }, // Cyan / Teal
    { label: "Hot Opportunity", value: 19, color: "#e53935" }, // Crimson / Red
    { label: "On Hold", value: 4, color: "#8d6e63" }, // Brown
  ];

  // Chart 3: Lost (Solid Pie)
  const lostSlices: PieSlice[] = [
    { label: "Budget Constraint", value: 45, color: "#facc15" }, // Yellow/Amber
    { label: "Competitor Chosen", value: 35, color: "#1b5e20" }, // Dark Green
    { label: "Not Interested", value: 8, color: "#d32f2f" }, // Red
    { label: "Unresponsive", value: 5, color: "#00bcd4" }, // Cyan
    { label: "Feature Gap", value: 4, color: "#8d6e63" }, // Brown
    { label: "Other", value: 3, color: "#a1887f" }, // Tan
  ];

  // Chart 4: Converted (Solid Pie)
  const convertedSlices: PieSlice[] = [
    { label: "Standard Plan", value: 73.5, color: "#ef5350" }, // Coral / Red
    { label: "Enterprise Custom", value: 26.5, color: "#26c6da" }, // Cyan / Turquoise
  ];

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Top action row */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Sales Reports</h1>
          <p className="text-sm text-muted-foreground">
            Lead conversion funnel and tag distribution analysis.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{timeRange}</span>
          </div>
          <Button variant="outline" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* SECTION 1: LEAD FUNNEL BY STAGES */}
      <section className="rounded-xl border border-border/80 bg-card shadow-xs">
        <div className="border-b border-border/80 px-6 py-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">
            LEAD FUNNEL BY STAGES
          </h2>
        </div>

        <div className="flex flex-col items-center justify-between gap-8 p-6 lg:flex-row">
          {/* Left Column: 3 Stacked Metric Cards */}
          <div className="flex w-full flex-col gap-3.5 sm:w-64">
            <div className="rounded-sm border border-border/80 bg-background/50 p-4 text-center shadow-xs">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                TOTAL LEADS
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                180323
              </p>
            </div>

            <div className="rounded-sm border border-border/80 bg-background/50 p-4 text-center shadow-xs">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                TOTAL IN-PROGRESS
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                23203
              </p>
            </div>

            <div className="rounded-sm border border-border/80 bg-background/50 p-4 text-center shadow-xs">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                TOTAL CLOSED
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
                39702
              </p>
            </div>
          </div>

          {/* Right Column: Visual Lead Funnel */}
          <div className="flex flex-1 items-center justify-center overflow-x-auto py-2">
            <svg
              viewBox="0 0 540 210"
              className="h-auto w-full max-w-[540px] overflow-visible"
            >
              {/* SLICE 1: New Leads (Top wide inverted trapezoid) */}
              <polygon
                points="80,15 320,15 235,100 165,100"
                fill="#29b6f6"
                className="cursor-pointer transition-opacity duration-150 hover:opacity-90"
              >
                <title>New Leads: 65.12%</title>
              </polygon>
              {/* Pointer line + label for New Leads */}
              <line
                x1="285"
                y1="52"
                x2="330"
                y2="52"
                stroke="currentColor"
                strokeWidth="1.2"
                className="text-muted-foreground/60"
              />
              <text
                x="338"
                y="56"
                className="fill-foreground text-[12px] font-bold"
              >
                New Leads(65.12 %)
              </text>

              {/* SLICE 2: Connected But Busy */}
              <polygon
                points="165,100 235,100 235,106 165,106"
                fill="#7c4dff"
                className="cursor-pointer transition-opacity duration-150 hover:opacity-90"
              >
                <title>Connected But Busy: 2.69%</title>
              </polygon>
              {/* Pointer line + label */}
              <polyline
                points="235,103 260,94 290,94"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                className="text-muted-foreground/60"
              />
              <text
                x="298"
                y="98"
                className="fill-foreground text-[12px] font-bold"
              >
                Connected But Busy(2.69 %)
              </text>

              {/* SLICE 3: Follow-up */}
              <polygon
                points="165,106 235,106 235,130 165,130"
                fill="#00e676"
                className="cursor-pointer transition-opacity duration-150 hover:opacity-90"
              >
                <title>Follow-up: 9.83%</title>
              </polygon>
              {/* Pointer line + label */}
              <line
                x1="235"
                y1="118"
                x2="290"
                y2="118"
                stroke="currentColor"
                strokeWidth="1.2"
                className="text-muted-foreground/60"
              />
              <text
                x="298"
                y="122"
                className="fill-foreground text-[12px] font-bold"
              >
                Follow-up(9.83 %)
              </text>

              {/* SLICE 4: May buy later */}
              <polygon
                points="165,130 235,130 235,137 165,137"
                fill="#ff9100"
                className="cursor-pointer transition-opacity duration-150 hover:opacity-90"
              >
                <title>May buy later: 0.21%</title>
              </polygon>
              {/* Pointer line + label */}
              <polyline
                points="235,134 260,142 290,142"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                className="text-muted-foreground/60"
              />
              <text
                x="298"
                y="146"
                className="fill-foreground text-[12px] font-bold"
              >
                May buy later(0.21 %)
              </text>

              {/* SLICE 5: Interested */}
              <polygon
                points="165,137 235,137 235,145 165,145"
                fill="#d500f9"
                className="cursor-pointer transition-opacity duration-150 hover:opacity-90"
              >
                <title>Interested: 0.14%</title>
              </polygon>
              {/* Pointer line + label */}
              <polyline
                points="235,141 260,166 290,166"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                className="text-muted-foreground/60"
              />
              <text
                x="298"
                y="170"
                className="fill-foreground text-[12px] font-bold"
              >
                Interested(0.14 %)
              </text>
            </svg>
          </div>
        </div>
      </section>

      {/* SECTION 2: LEADS BY TAGS */}
      <section className="rounded-xl border border-border/80 bg-card shadow-xs">
        <div className="border-b border-border/80 px-6 py-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">
            LEADS BY TAGS
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-8 p-6 sm:grid-cols-2 lg:grid-cols-4">
          {/* Chart 1: New Leads (Donut) */}
          <div className="flex flex-col items-center">
            <CircleChart slices={newLeadsSlices} isDonut={true} size={170} />
            <p className="mt-4 text-sm font-bold text-foreground">New Leads</p>
          </div>

          {/* Chart 2: IN-PROGRESS (Donut) */}
          <div className="flex flex-col items-center">
            <CircleChart slices={inProgressSlices} isDonut={true} size={170} />
            <p className="mt-4 text-sm font-bold text-foreground">IN-PROGRESS</p>
          </div>

          {/* Chart 3: Lost (Solid Pie) */}
          <div className="flex flex-col items-center">
            <CircleChart slices={lostSlices} isDonut={false} size={170} />
            <p className="mt-4 text-sm font-bold text-foreground">Lost</p>
          </div>

          {/* Chart 4: Converted (Solid Pie) */}
          <div className="flex flex-col items-center">
            <CircleChart slices={convertedSlices} isDonut={false} size={170} />
            <p className="mt-4 text-sm font-bold text-foreground">Converted</p>
          </div>
        </div>
      </section>
    </div>
  );
}

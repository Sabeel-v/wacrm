"use client";

import { useState } from "react";
import {
  BarChart3,
  TrendingUp,
  DollarSign,
  Award,
  Briefcase,
  Calendar,
  Download,
  ArrowUpRight,
  ChevronDown,
  Percent,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function ReportsPage() {
  const [timeRange, setTimeRange] = useState("Last 30 Days");

  const STAGE_BREAKDOWN = [
    { name: "New Lead", count: 24, value: "$36,000", percentage: 65, color: "bg-blue-500" },
    { name: "Qualified", count: 18, value: "$45,200", percentage: 50, color: "bg-yellow-500" },
    { name: "Proposal Sent", count: 12, value: "$38,400", percentage: 35, color: "bg-orange-500" },
    { name: "Negotiation", count: 8, value: "$28,900", percentage: 22, color: "bg-purple-500" },
    { name: "Won", count: 14, value: "$36,000", percentage: 40, color: "bg-emerald-500" },
  ];

  const SOURCES = [
    { name: "WhatsApp Direct", deals: 42, revenue: "$89,400", winRate: "72%" },
    { name: "Website Chat Widget", deals: 26, revenue: "$52,100", winRate: "64%" },
    { name: "Broadcast Campaigns", deals: 18, revenue: "$31,500", winRate: "58%" },
    { name: "Client Referrals", deals: 9, revenue: "$21,500", winRate: "89%" },
  ];

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Sales performance analytics, pipeline velocity, and conversion insights.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{timeRange}</span>
          </div>
          <Button variant="outline" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            Export Report
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Total Pipeline Value</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <DollarSign className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">$184,500</p>
          <p className="mt-1 flex items-center text-xs text-emerald-500 font-medium">
            <ArrowUpRight className="mr-1 h-3.5 w-3.5" /> +18.4% vs last period
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Deals Won</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
              <Award className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">34</p>
          <p className="mt-1 text-xs text-muted-foreground">Total $72,400 closed</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Win Rate</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
              <Percent className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">68.4%</p>
          <p className="mt-1 flex items-center text-xs text-emerald-500 font-medium">
            <ArrowUpRight className="mr-1 h-3.5 w-3.5" /> +4.1% improvement
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Avg Deal Size</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
              <Briefcase className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">$5,426</p>
          <p className="mt-1 text-xs text-muted-foreground">Across all stages</p>
        </div>
      </div>

      {/* Analytics Breakdown Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Pipeline Stage Distribution */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between pb-4 border-b border-border">
            <div>
              <h2 className="text-base font-semibold text-foreground">Pipeline Stage Distribution</h2>
              <p className="text-xs text-muted-foreground">Active deals and volume by stage</p>
            </div>
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="mt-6 space-y-4">
            {STAGE_BREAKDOWN.map((stage) => (
              <div key={stage.name} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="text-foreground">{stage.name} ({stage.count} deals)</span>
                  <span className="text-muted-foreground">{stage.value}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${stage.color}`}
                    style={{ width: `${stage.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Lead Source Performance */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between pb-4 border-b border-border">
            <div>
              <h2 className="text-base font-semibold text-foreground">Channel Conversion Performance</h2>
              <p className="text-xs text-muted-foreground">Conversion metrics segmented by channel</p>
            </div>
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="mt-4 divide-y divide-border">
            {SOURCES.map((source) => (
              <div key={source.name} className="flex items-center justify-between py-3.5">
                <div>
                  <p className="text-sm font-medium text-foreground">{source.name}</p>
                  <p className="text-xs text-muted-foreground">{source.deals} deals initiated</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-foreground">{source.revenue}</p>
                  <Badge variant="outline" className="mt-0.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-500 text-[10px]">
                    {source.winRate} win rate
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

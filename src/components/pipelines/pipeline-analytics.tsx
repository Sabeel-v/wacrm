"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import { BarChart3, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const { defaultCurrency } = useAuth();
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stats = useMemo(() => {
    const dealsByStage = new Map<string, Deal[]>();
    for (const stage of sortedStages) dealsByStage.set(stage.id, []);
    for (const deal of deals) {
      const bucket = dealsByStage.get(deal.stage_id);
      if (bucket) bucket.push(deal);
    }

    const totalCount = deals.length;
    const totalValue = deals.reduce((sum, d) => sum + Number(d.value || 0), 0);

    const stageItems = sortedStages.map((stage) => {
      const stageDeals = dealsByStage.get(stage.id) ?? [];
      const count = stageDeals.length;
      const stageValue = stageDeals.reduce(
        (sum, d) => sum + Number(d.value || 0),
        0,
      );
      return {
        stage,
        count,
        totalValue: stageValue,
      };
    });

    return {
      totalCount,
      totalValue,
      stageItems,
    };
  }, [sortedStages, deals]);

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          icon={<BarChart3 className="h-4 w-4 text-primary shrink-0" />}
          label={t("totalDeals")}
          value={String(stats.totalCount)}
          subValue={formatCurrency(stats.totalValue, defaultCurrency)}
          tooltip={`${t("totalDeals")}: ${stats.totalCount} deals (${formatCurrency(stats.totalValue, defaultCurrency)})`}
          t={t}
        />
        {stats.stageItems.map(({ stage, count, totalValue }) => (
          <Metric
            key={stage.id}
            icon={
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: stage.color || "#3b82f6" }}
                aria-hidden
              />
            }
            label={stage.name}
            value={String(count)}
            subValue={formatCurrency(totalValue, defaultCurrency)}
            tooltip={`${stage.name}: ${count} ${count === 1 ? "deal" : "deals"} (${formatCurrency(totalValue, defaultCurrency)})`}
            t={t}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}

function Metric({
  icon,
  label,
  value,
  subValue,
  tooltip,
  t,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  subValue?: string;
  tooltip: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3 min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground min-w-0">
        {icon}
        <span className="truncate">{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t("howCalculated", { label })}
                className="ml-auto text-muted-foreground hover:text-foreground focus:outline-none shrink-0"
              />
            }
          >
            <Info className="h-3 w-3" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-left">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="mt-1 text-base font-semibold text-foreground">{value}</p>
      {subValue && (
        <p className="text-xs text-muted-foreground truncate">{subValue}</p>
      )}
    </div>
  );
}

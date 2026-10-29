"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations } from "next-intl";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stageItems = useMemo(() => {
    const dealsByStage = new Map<string, Deal[]>();
    for (const stage of sortedStages) dealsByStage.set(stage.id, []);
    for (const deal of deals) {
      const bucket = dealsByStage.get(deal.stage_id);
      if (bucket) bucket.push(deal);
    }

    return sortedStages.map((stage) => {
      const stageDeals = dealsByStage.get(stage.id) ?? [];
      return {
        stage,
        count: stageDeals.length,
      };
    });
  }, [sortedStages, deals]);

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 xl:grid-cols-6">
        {stageItems.map(({ stage, count }) => (
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
            tooltip={`${stage.name}: ${count} ${count === 1 ? "lead" : "leads"}`}
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
  tooltip,
  t,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
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
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  CheckCircle2,
  PauseCircle,
  AlertTriangle,
  Play,
  Pause,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BroadcastBatchState } from '@/hooks/use-broadcast-sending';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
  batchState?: BroadcastBatchState;
  onPause?: () => void;
  onResume?: () => void;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
  batchState,
  onPause,
  onResume,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Real-time Batch Processing & Progress Overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {batchState?.status === 'paused' ? (
                <PauseCircle className="h-4 w-4 text-amber-500" />
              ) : batchState?.status === 'completed' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : batchState?.status === 'error' ? (
                <AlertTriangle className="h-4 w-4 text-destructive" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              )}
              <span className="text-sm font-semibold text-foreground">
                {batchState?.status === 'paused'
                  ? 'Broadcast Paused'
                  : batchState?.status === 'completed'
                    ? 'Broadcast Completed'
                    : batchState?.status === 'error'
                      ? 'Broadcast Interrupted'
                      : t('scheduleSend.sending')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {onPause && onResume && batchState && (
                batchState.status === 'sending' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onPause}
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Pause className="mr-1 h-3.5 w-3.5" />
                    Pause
                  </Button>
                ) : batchState.status === 'paused' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onResume}
                    className="h-7 px-2 text-xs text-primary hover:text-primary/90"
                  >
                    <Play className="mr-1 h-3.5 w-3.5" />
                    Resume
                  </Button>
                ) : null
              )}
              <span className="text-xs font-semibold text-primary">
                {batchState?.progressPercent ?? progress}%
              </span>
            </div>
          </div>

          {/* Real-time status text */}
          <p className="text-xs text-muted-foreground">
            {batchState?.statusMessage || t('scheduleSend.sending')}
          </p>

          {/* Progress Bar */}
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-2 rounded-full transition-all duration-300 ${
                batchState?.status === 'paused'
                  ? 'bg-amber-500'
                  : batchState?.status === 'error'
                    ? 'bg-destructive'
                    : 'bg-primary'
              }`}
              style={{ width: `${batchState?.progressPercent ?? progress}%` }}
            />
          </div>

          {/* Batch Metrics Pills */}
          {batchState && batchState.totalBatches > 0 && (
            <div className="grid grid-cols-3 gap-2 pt-1 text-center text-xs">
              <div className="rounded-lg bg-muted/60 p-2 border border-border/50">
                <span className="block text-muted-foreground">Batch</span>
                <span className="font-semibold text-foreground">
                  {batchState.currentBatch} / {batchState.totalBatches}
                </span>
              </div>
              <div className="rounded-lg bg-emerald-500/10 p-2 border border-emerald-500/20">
                <span className="block text-emerald-600 dark:text-emerald-400">Sent</span>
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {batchState.sentCount}
                </span>
              </div>
              <div className="rounded-lg bg-destructive/10 p-2 border border-destructive/20">
                <span className="block text-destructive">Failed</span>
                <span className="font-semibold text-destructive">
                  {batchState.failedCount}
                </span>
              </div>
            </div>
          )}

          {/* Failed batches notice */}
          {batchState?.failedBatches && batchState.failedBatches.length > 0 && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-2.5 text-xs text-destructive space-y-1">
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{batchState.failedBatches.length} batch(es) encountered network or delivery issues</span>
              </div>
              <div className="max-h-20 overflow-y-auto space-y-0.5 text-[11px] opacity-90 pl-5">
                {batchState.failedBatches.map((fb) => (
                  <div key={fb.batchIndex}>
                    Batch #{fb.batchIndex} ({fb.recipientCount} recipients): {fb.error}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            <Send className="h-4 w-4" />
            {t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('scheduleSend.confirmTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich('scheduleSend.confirmDesc', {
                  count: estimatedReach,
                  template: template.name,
                  b: (chunks) => (
                    <span className="font-medium text-popover-foreground">{chunks}</span>
                  ),
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Send className="h-4 w-4" />
                {t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}

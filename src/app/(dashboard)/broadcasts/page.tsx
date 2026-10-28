'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Radio,
  Plus,
  Loader2,
  Calendar,
  Search,
  X,
  RotateCcw,
  ArrowUpDown,
  Filter,
  User as UserIcon,
} from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  MARKETING: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  UTILITY: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  AUTHENTICATION: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateCell({
  value,
  total,
}: {
  value: number;
  total: number;
  /** Kept optional for backward compatibility */
  color?: string;
}) {
  const pct = percent(value, total);
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {pct}%
    </span>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.page');
  const tStatus = useTranslations('Broadcasts.status');
  const canCreate = useCan('send-messages');

  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [templateCategories, setTemplateCategories] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<{ user_id: string; full_name?: string | null; email?: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [createdByFilter, setCreatedByFilter] = useState('all');
  const [datePreset, setDatePreset] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [sortAsc, setSortAsc] = useState(false);

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts(isPolling = false) {
    try {
      const supabase = createClient();

      if (!isPolling) {
        const [broadcastRes, templatesRes, profilesRes] = await Promise.all([
          supabase.from('broadcasts').select('*').order('created_at', { ascending: false }),
          supabase.from('message_templates').select('name, category'),
          supabase.from('profiles').select('user_id, full_name, email'),
        ]);

        if (broadcastRes.error) throw broadcastRes.error;
        setBroadcasts(broadcastRes.data ?? []);

        if (templatesRes.data) {
          const map: Record<string, string> = {};
          templatesRes.data.forEach((tpl) => {
            if (tpl.name && tpl.category) {
              map[tpl.name] = tpl.category;
            }
          });
          setTemplateCategories(map);
        }

        if (profilesRes.data) {
          setProfiles(profilesRes.data);
        }
      } else {
        const { data, error: fetchError } = await supabase
          .from('broadcasts')
          .select('*')
          .order('created_at', { ascending: false });

        if (fetchError) throw fetchError;
        setBroadcasts(data ?? []);
      }
    } catch (err) {
      if (!isPolling) {
        setError(err instanceof Error ? err.message : t('errorLoad'));
      }
    } finally {
      if (!isPolling) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    fetchBroadcasts();
  }, []);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === 'sending'),
    [broadcasts],
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(() => fetchBroadcasts(true), POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts(true);
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anySending]);

  const profilesMap = useMemo(() => {
    const map = new Map<string, string>();
    profiles.forEach((p) => {
      const name = p.full_name?.trim() || p.email?.split('@')[0] || p.email || 'User';
      map.set(p.user_id, name);
    });
    return map;
  }, [profiles]);

  const creatorOptions = useMemo(() => {
    const creators: { id: string; name: string }[] = [];
    const seen = new Set<string>();

    profiles.forEach((p) => {
      if (!seen.has(p.user_id)) {
        seen.add(p.user_id);
        const name = p.full_name?.trim() || p.email?.split('@')[0] || p.email || 'User';
        creators.push({ id: p.user_id, name });
      }
    });

    broadcasts.forEach((b) => {
      if (b.user_id && !seen.has(b.user_id)) {
        seen.add(b.user_id);
        creators.push({ id: b.user_id, name: `User (${b.user_id.slice(0, 6)})` });
      }
    });

    return creators;
  }, [profiles, broadcasts]);

  const availableCategories = useMemo(() => {
    const defaultCats = ['Marketing', 'Utility', 'Authentication'];
    const found = new Set<string>(defaultCats);
    Object.values(templateCategories).forEach((c) => {
      if (c) {
        const titleCase = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
        found.add(titleCase);
      }
    });
    return Array.from(found);
  }, [templateCategories]);

  const filteredBroadcasts = useMemo(() => {
    return broadcasts
      .filter((broadcast) => {
        // Search query
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const nameMatch = broadcast.name?.toLowerCase().includes(q);
          const templateMatch = broadcast.template_name?.toLowerCase().includes(q);
          if (!nameMatch && !templateMatch) return false;
        }

        // Status filter
        if (statusFilter !== 'all' && broadcast.status !== statusFilter) {
          return false;
        }

        // Category filter
        if (categoryFilter !== 'all') {
          const cat = templateCategories[broadcast.template_name];
          if (!cat || cat.toLowerCase() !== categoryFilter.toLowerCase()) {
            return false;
          }
        }

        // Created by filter
        if (createdByFilter !== 'all' && broadcast.user_id !== createdByFilter) {
          return false;
        }

        // Date wise filter
        if (datePreset !== 'all') {
          const createdAt = new Date(broadcast.created_at);
          const now = new Date();

          if (datePreset === 'today') {
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            if (createdAt < startOfToday) return false;
          } else if (datePreset === 'yesterday') {
            const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            const endOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, -1);
            if (createdAt < startOfYesterday || createdAt > endOfYesterday) return false;
          } else if (datePreset === '7d') {
            const sevenDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
            if (createdAt < sevenDaysAgo) return false;
          } else if (datePreset === '30d') {
            const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
            if (createdAt < thirtyDaysAgo) return false;
          } else if (datePreset === 'this_month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            if (createdAt < startOfMonth) return false;
          } else if (datePreset === 'custom') {
            if (customFrom) {
              const fromDate = new Date(`${customFrom}T00:00:00`);
              if (createdAt < fromDate) return false;
            }
            if (customTo) {
              const toDate = new Date(`${customTo}T23:59:59.999`);
              if (createdAt > toDate) return false;
            }
          }
        }

        return true;
      })
      .sort((a, b) => {
        const timeA = new Date(a.created_at).getTime();
        const timeB = new Date(b.created_at).getTime();
        return sortAsc ? timeA - timeB : timeB - timeA;
      });
  }, [
    broadcasts,
    searchQuery,
    statusFilter,
    categoryFilter,
    createdByFilter,
    datePreset,
    customFrom,
    customTo,
    sortAsc,
    templateCategories,
  ]);

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    statusFilter !== 'all' ||
    categoryFilter !== 'all' ||
    createdByFilter !== 'all' ||
    datePreset !== 'all' ||
    customFrom !== '' ||
    customTo !== '';

  function clearFilters() {
    setSearchQuery('');
    setStatusFilter('all');
    setCategoryFilter('all');
    setCreatedByFilter('all');
    setDatePreset('all');
    setCustomFrom('');
    setCustomTo('');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label={t('broadcastInProgress')}
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-muted"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <GatedButton
          canAct={canCreate}
          gateReason="create broadcasts"
          onClick={() => router.push('/broadcasts/new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('newBroadcast')}
        </GatedButton>
      </div>

      {broadcasts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-border bg-card">
          <Radio className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noBroadcastsYet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('createFirst')}
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason="create broadcasts"
            onClick={() => router.push('/broadcasts/new')}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Filters Bar */}
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Search */}
              <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('filters.searchPlaceholder')}
                  className="h-8 pl-8 pr-7 text-xs bg-background border-border"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Status Filter */}
              <div className="flex items-center gap-1.5">
                <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
                  <SelectTrigger className="h-8 text-xs bg-background border-border min-w-[125px]">
                    <span className="text-muted-foreground mr-1">{t('filters.status')}:</span>
                    <SelectValue placeholder={t('filters.allStatuses')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('filters.allStatuses')}</SelectItem>
                    <SelectItem value="draft">{tStatus('draft')}</SelectItem>
                    <SelectItem value="scheduled">{tStatus('scheduled')}</SelectItem>
                    <SelectItem value="sending">{tStatus('sending')}</SelectItem>
                    <SelectItem value="sent">{tStatus('sent')}</SelectItem>
                    <SelectItem value="failed">{tStatus('failed')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Category Filter */}
              <div className="flex items-center gap-1.5">
                <Select value={categoryFilter} onValueChange={(v) => v && setCategoryFilter(v)}>
                  <SelectTrigger className="h-8 text-xs bg-background border-border min-w-[130px]">
                    <span className="text-muted-foreground mr-1">{t('filters.category')}:</span>
                    <SelectValue placeholder={t('filters.allCategories')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('filters.allCategories')}</SelectItem>
                    {availableCategories.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Created By Filter */}
              <div className="flex items-center gap-1.5">
                <Select value={createdByFilter} onValueChange={(v) => v && setCreatedByFilter(v)}>
                  <SelectTrigger className="h-8 text-xs bg-background border-border min-w-[140px]">
                    <span className="text-muted-foreground mr-1">{t('filters.createdBy')}:</span>
                    <SelectValue placeholder={t('filters.allCreators')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('filters.allCreators')}</SelectItem>
                    {creatorOptions.map((creator) => (
                      <SelectItem key={creator.id} value={creator.id}>
                        {creator.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Date Wise Filter */}
              <div className="flex items-center gap-1.5">
                <Select value={datePreset} onValueChange={(v) => v && setDatePreset(v)}>
                  <SelectTrigger className="h-8 text-xs bg-background border-border min-w-[130px]">
                    <Calendar className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
                    <SelectValue placeholder={t('filters.dateWise')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('filters.allTime')}</SelectItem>
                    <SelectItem value="today">{t('filters.today')}</SelectItem>
                    <SelectItem value="yesterday">{t('filters.yesterday')}</SelectItem>
                    <SelectItem value="7d">{t('filters.last7Days')}</SelectItem>
                    <SelectItem value="30d">{t('filters.last30Days')}</SelectItem>
                    <SelectItem value="this_month">{t('filters.thisMonth')}</SelectItem>
                    <SelectItem value="custom">{t('filters.customRange')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Reset/Clear button */}
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="h-8 text-xs text-muted-foreground hover:text-foreground px-2.5 gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('filters.clearFilters')}
                </Button>
              )}
            </div>

            {/* Custom Date Range selector */}
            {datePreset === 'custom' && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/50 text-xs text-muted-foreground">
                <span>{t('filters.from')}:</span>
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-7 w-[135px] text-xs bg-background border-border"
                />
                <span>{t('filters.to')}:</span>
                <Input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-7 w-[135px] text-xs bg-background border-border"
                />
                {(customFrom || customTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setCustomFrom('');
                      setCustomTo('');
                    }}
                    className="h-7 text-xs px-2"
                  >
                    {t('filters.clear')}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Table or Empty Filtered State */}
          {filteredBroadcasts.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-border bg-card p-6 text-center">
              <Filter className="mb-2.5 h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm font-medium text-foreground">{t('filters.noMatching')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('filters.noMatchingDesc')}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={clearFilters}
                className="mt-4 gap-1.5 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('filters.clearFilters')}
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">{t('table.name')}</TableHead>
                    <TableHead className="hidden text-muted-foreground md:table-cell">{t('table.template')}</TableHead>
                    <TableHead className="hidden text-muted-foreground xl:table-cell">{t('table.category')}</TableHead>
                    <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                      {t('table.recipients')}
                    </TableHead>
                    <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.delivery')}</TableHead>
                    <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.read')}</TableHead>
                    <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                    <TableHead className="hidden text-muted-foreground xl:table-cell">{t('table.createdBy')}</TableHead>
                    <TableHead
                      className="hidden text-muted-foreground sm:table-cell cursor-pointer select-none hover:text-foreground transition-colors"
                      onClick={() => setSortAsc((prev) => !prev)}
                      title="Click to sort date"
                    >
                      <div className="flex items-center gap-1">
                        <span>{t('table.date')}</span>
                        <ArrowUpDown className={cn('h-3.5 w-3.5', sortAsc ? 'text-primary' : 'text-muted-foreground')} />
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBroadcasts.map((broadcast) => {
                    const status = getBroadcastStatus(broadcast.status);
                    const category = templateCategories[broadcast.template_name];
                    const normalizedCat = category
                      ? category.charAt(0).toUpperCase() + category.slice(1).toLowerCase()
                      : null;
                    const creatorName = profilesMap.get(broadcast.user_id) || 'User';

                    return (
                      <TableRow
                        key={broadcast.id}
                        className="cursor-pointer border-border hover:bg-muted/50"
                        onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                      >
                        <TableCell className="font-medium text-foreground">
                          {broadcast.name}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {broadcast.template_name}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground xl:table-cell">
                          {normalizedCat ? (
                            <span
                              className={cn(
                                'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium',
                                categoryColors[normalizedCat] ?? 'bg-muted text-muted-foreground border-border'
                              )}
                            >
                              {normalizedCat}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                          {broadcast.total_recipients}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <RateCell
                            value={broadcast.delivered_count}
                            total={broadcast.total_recipients}
                            color="bg-primary"
                          />
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <RateCell
                            value={broadcast.read_count}
                            total={broadcast.total_recipients}
                            color="bg-blue-500"
                          />
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                          >
                            {status.pulse && (
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                              </span>
                            )}
                            {tStatus(status.label)}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground text-xs xl:table-cell">
                          <span className="inline-flex items-center gap-1.5">
                            <UserIcon className="h-3 w-3 text-muted-foreground/70" />
                            {creatorName}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">
                          {new Date(broadcast.created_at).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


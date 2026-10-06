'use client';

import { useEffect, useState, useCallback, useTransition } from 'react';
import {
  Download,
  Loader2,
  Search,
  Users,
  Calendar,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Phone,
  User,
  Clock,
  Hash,
} from 'lucide-react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Badge } from '@/components/ui/badge';
import type { NodeLeadItem, NodeLeadsResult } from '@/lib/flows/node-leads';

interface NodeLeadsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flowId: string;
  nodeKey: string;
  nodeName?: string;
  nodeType?: string;
}

type DateRangePreset = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';

export function NodeLeadsModal({
  open,
  onOpenChange,
  flowId,
  nodeKey,
  nodeName,
}: NodeLeadsModalProps) {
  const [leads, setLeads] = useState<NodeLeadItem[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;
  const [datePreset, setDatePreset] = useState<DateRangePreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Compute ISO date range
  const getDateRange = useCallback((): { date_from?: string; date_to?: string } => {
    const now = new Date();
    switch (datePreset) {
      case 'today':
        return {
          date_from: startOfDay(now).toISOString(),
          date_to: endOfDay(now).toISOString(),
        };
      case 'yesterday': {
        const yesterday = subDays(now, 1);
        return {
          date_from: startOfDay(yesterday).toISOString(),
          date_to: endOfDay(yesterday).toISOString(),
        };
      }
      case '7d':
        return {
          date_from: subDays(now, 7).toISOString(),
          date_to: now.toISOString(),
        };
      case '30d':
        return {
          date_from: subDays(now, 30).toISOString(),
          date_to: now.toISOString(),
        };
      case 'custom':
        return {
          date_from: customFrom ? new Date(`${customFrom}T00:00:00`).toISOString() : undefined,
          date_to: customTo ? new Date(`${customTo}T23:59:59.999`).toISOString() : undefined,
        };
      case 'all':
      default:
        return {};
    }
  }, [datePreset, customFrom, customTo]);

  const fetchLeads = useCallback(async () => {
    if (!open || !flowId || !nodeKey) return;
    setLoading(true);
    try {
      const { date_from, date_to } = getDateRange();
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });

      if (debouncedSearch) params.set('search', debouncedSearch);
      if (date_from) params.set('date_from', date_from);
      if (date_to) params.set('date_to', date_to);

      const res = await fetch(`/api/flows/${flowId}/nodes/${encodeURIComponent(nodeKey)}/leads?${params.toString()}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Failed to fetch leads (${res.status})`);
      }

      const json = (await res.json()) as NodeLeadsResult;
      setLeads(json.data || []);
      setTotal(json.total || 0);
    } catch (err) {
      console.error('[node-leads] error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to load node leads');
    } finally {
      setLoading(false);
    }
  }, [open, flowId, nodeKey, page, limit, debouncedSearch, getDateRange]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  // CSV Export
  const handleExportCsv = async () => {
    if (!flowId || !nodeKey) return;
    setExporting(true);
    try {
      const { date_from, date_to } = getDateRange();
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (date_from) params.set('date_from', date_from);
      if (date_to) params.set('date_to', date_to);

      const res = await fetch(
        `/api/flows/${flowId}/nodes/${encodeURIComponent(nodeKey)}/leads/export?${params.toString()}`,
      );

      if (!res.ok) {
        throw new Error('CSV export failed');
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leads-${nodeKey}-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast.success('Leads exported successfully');
    } catch (err) {
      console.error('[node-leads-export] error:', err);
      toast.error('Failed to export CSV');
    } finally {
      setExporting(false);
    }
  };

  const displayName = nodeName || nodeKey;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const formatLeadDate = (isoStr: string) => {
    try {
      return format(new Date(isoStr), 'dd MMM yyyy HH:mm');
    } catch {
      return isoStr;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden sm:max-w-4xl border-border bg-card">
        {/* Header */}
        <DialogHeader className="border-b border-border px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pr-6">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <DialogTitle className="text-base font-semibold tracking-tight text-foreground">
                  {displayName} — Node Leads
                </DialogTitle>
                <Badge variant="secondary" className="font-mono text-xs font-semibold">
                  Total Leads: {total}
                </Badge>
              </div>
              <DialogDescription className="text-xs text-muted-foreground">
                Contacts who reached this node during WhatsApp flow execution.
              </DialogDescription>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={exporting || total === 0}
              className="gap-1.5 text-xs font-medium"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Export CSV
            </Button>
          </div>
        </DialogHeader>

        {/* Toolbar: Search & Date Filters */}
        <div className="border-b border-border bg-muted/40 px-6 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Search */}
            <div className="relative min-w-[220px] max-w-xs flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search phone or name..."
                className="h-8 pl-8 text-xs bg-background"
              />
            </div>

            {/* Date filter */}
            <div className="flex items-center gap-2">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <Select
                value={datePreset}
                onValueChange={(v) => {
                  setDatePreset(v as DateRangePreset);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-[140px] text-xs bg-background">
                  <SelectValue placeholder="Date range" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All time</SelectItem>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="yesterday">Yesterday</SelectItem>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                  <SelectItem value="30d">Last 30 days</SelectItem>
                  <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
              </Select>

              {datePreset === 'custom' && (
                <div className="flex items-center gap-1.5">
                  <Input
                    type="date"
                    value={customFrom}
                    onChange={(e) => {
                      setCustomFrom(e.target.value);
                      setPage(1);
                    }}
                    className="h-8 w-[125px] text-xs bg-background"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="date"
                    value={customTo}
                    onChange={(e) => {
                      setCustomTo(e.target.value);
                      setPage(1);
                    }}
                    className="h-8 w-[125px] text-xs bg-background"
                  />
                </div>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchLeads()}
                disabled={loading}
                title="Refresh leads"
                className="h-8 w-8 p-0"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </div>

        {/* Leads Table */}
        <div className="max-h-[460px] min-h-[260px] overflow-auto px-6 py-2">
          {loading && leads.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-xs">Loading leads...</p>
            </div>
          ) : leads.length === 0 ? (
            <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <Users className="h-8 w-8 opacity-40" />
              <p className="text-sm font-medium text-foreground">No leads found</p>
              <p className="max-w-xs text-xs">
                {search || datePreset !== 'all'
                  ? 'No contacts matched your search or date filter.'
                  : 'Contacts will appear here as soon as they reach this node in the flow.'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-[180px] text-xs font-semibold">Phone</TableHead>
                  <TableHead className="text-xs font-semibold">Name</TableHead>
                  <TableHead className="w-[170px] text-xs font-semibold">First Reached</TableHead>
                  <TableHead className="w-[170px] text-xs font-semibold">Last Reached</TableHead>
                  <TableHead className="w-[80px] text-right text-xs font-semibold">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => (
                  <TableRow key={lead.contact_id} className="border-border">
                    <TableCell className="font-mono text-xs font-medium text-foreground">
                      {lead.phone || '—'}
                    </TableCell>
                    <TableCell className="text-xs text-foreground">
                      {lead.name ? lead.name : <span className="text-muted-foreground italic">No name</span>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatLeadDate(lead.first_reached_at)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatLeadDate(lead.last_reached_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={lead.reach_count > 1 ? 'default' : 'secondary'}
                        className="font-mono text-[11px] px-1.5 py-0"
                      >
                        {lead.reach_count}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Footer with pagination */}
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-6 py-3">
          <div className="text-xs text-muted-foreground">
            {total > 0 ? (
              <>
                Showing{' '}
                <span className="font-medium text-foreground">
                  {(page - 1) * limit + 1}
                </span>{' '}
                to{' '}
                <span className="font-medium text-foreground">
                  {Math.min(page * limit, total)}
                </span>{' '}
                of <span className="font-medium text-foreground">{total}</span> leads
              </>
            ) : (
              '0 leads'
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="h-7 px-2 text-xs"
            >
              <ChevronLeft className="h-3.5 w-3.5 mr-1" />
              Previous
            </Button>
            <span className="px-2 text-xs text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="h-7 px-2 text-xs"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

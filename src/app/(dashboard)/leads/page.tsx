"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Search,
  Download,
  Plus,
  Mail,
  Phone,
  MoreHorizontal,
  Loader2,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { DealForm } from "@/components/pipelines/deal-form";
import type { Deal, Contact, PipelineStage, Pipeline } from "@/types";

interface LeadItem {
  id: string;
  dealId?: string;
  contactId?: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  source: string;
  status: string;
  statusColor?: string;
  assignedTo: string;
  createdAt: string;
  rawDeal?: Deal;
}

function formatRelativeTime(dateStr?: string) {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "-";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function LeadsPage() {
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("All");

  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);

  // Deal Form modal state
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Load pipelines
      const { data: pipelinesData } = await supabase
        .from("pipelines")
        .select("*")
        .order("created_at");

      const pList = (pipelinesData ?? []) as Pipeline[];
      setPipelines(pList);
      const activePipelineId = pList[0]?.id ?? "";
      setSelectedPipelineId(activePipelineId);

      // 2. Load stages for this pipeline (or all stages if none)
      let stagesList: PipelineStage[] = [];
      if (activePipelineId) {
        const { data: stagesData } = await supabase
          .from("pipeline_stages")
          .select("*")
          .eq("pipeline_id", activePipelineId)
          .order("position");
        stagesList = (stagesData ?? []) as PipelineStage[];
      } else {
        const { data: stagesData } = await supabase
          .from("pipeline_stages")
          .select("*")
          .order("position");
        stagesList = (stagesData ?? []) as PipelineStage[];
      }
      setStages(stagesList);

      const stageById = new Map(stagesList.map((s) => [s.id, s]));

      // 3. Load deals with contact, stage, and assignee
      const { data: dealsData } = await supabase
        .from("deals")
        .select(`
          *,
          contact:contacts(*),
          stage:pipeline_stages(*),
          assignee:profiles!deals_assigned_to_fkey(*)
        `)
        .order("created_at", { ascending: false });

      const dealsList = (dealsData ?? []) as Deal[];

      // 4. Load contacts so contacts without a deal yet still appear as incoming leads
      const { data: contactsData } = await supabase
        .from("contacts")
        .select("*")
        .order("created_at", { ascending: false });

      const contactsList = (contactsData ?? []) as Contact[];

      const coveredContactIds = new Set<string>();
      const items: LeadItem[] = [];

      for (const d of dealsList) {
        if (d.contact_id) coveredContactIds.add(d.contact_id);
        const st = d.stage || stageById.get(d.stage_id);
        items.push({
          id: d.id,
          dealId: d.id,
          contactId: d.contact_id ?? undefined,
          name: d.contact?.name || d.title || "Unnamed Lead",
          company: d.contact?.company || "",
          email: d.contact?.email || "",
          phone: d.contact?.phone || "",
          source: "WhatsApp",
          status:
            st?.name ||
            (d.status === "won" ? "Won" : d.status === "lost" ? "Lost" : "New Lead"),
          statusColor: st?.color,
          assignedTo: d.assignee?.full_name || "Unassigned",
          createdAt: d.created_at,
          rawDeal: d,
        });
      }

      // Add contacts not yet linked to a deal
      const defaultStage = stagesList[0];
      for (const c of contactsList) {
        if (coveredContactIds.has(c.id)) continue;
        items.push({
          id: `contact-${c.id}`,
          contactId: c.id,
          name: c.name || c.phone || "Unnamed Contact",
          company: c.company || "",
          email: c.email || "",
          phone: c.phone || "",
          source: "WhatsApp",
          status: defaultStage?.name || "New Lead",
          statusColor: defaultStage?.color || "#3b82f6",
          assignedTo: "Unassigned",
          createdAt: c.created_at,
        });
      }

      setLeads(items);
    } catch (err) {
      console.error("Failed to load leads data:", err);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Status options for the single dropdown
  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of stages) {
      if (s.name) set.add(s.name);
    }
    for (const l of leads) {
      if (l.status) set.add(l.status);
    }
    return Array.from(set);
  }, [stages, leads]);

  // Filtered leads based on search query and status dropdown
  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        lead.name.toLowerCase().includes(q) ||
        lead.company.toLowerCase().includes(q) ||
        lead.email.toLowerCase().includes(q) ||
        lead.phone.includes(q) ||
        lead.assignedTo.toLowerCase().includes(q);

      const matchesStatus =
        statusFilter === "All" || lead.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [leads, searchQuery, statusFilter]);

  // KPI Calculations from real data
  const totalLeads = leads.length;

  const qualifiedLeads = useMemo(() => {
    return leads.filter((l) => {
      const s = l.status.toLowerCase();
      return (
        s.includes("qualified") ||
        s.includes("interested") ||
        s.includes("converted") ||
        s.includes("won")
      );
    }).length;
  }, [leads]);

  const convertedLeads = useMemo(() => {
    return leads.filter((l) => {
      const s = l.status.toLowerCase();
      return s.includes("converted") || s.includes("won");
    }).length;
  }, [leads]);

  const conversionRate =
    totalLeads > 0 ? ((convertedLeads / totalLeads) * 100).toFixed(1) : "0.0";

  const newToday = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return leads.filter((l) => l.createdAt && new Date(l.createdAt) >= today).length;
  }, [leads]);

  const handleExport = () => {
    if (filteredLeads.length === 0) return;
    const headers = [
      "Lead Name",
      "Company",
      "Email",
      "Phone",
      "Source",
      "Status",
      "Assigned Agent",
      "Created At",
    ];
    const rows = filteredLeads.map((l) => [
      l.name,
      l.company,
      l.email,
      l.phone,
      l.source,
      l.status,
      l.assignedTo,
      l.createdAt,
    ]);
    const csvContent =
      "data:text/csv;charset=utf-8," +
      [headers, ...rows]
        .map((e) =>
          e.map((val) => `"${(val || "").replace(/"/g, '""')}"`).join(",")
        )
        .join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute(
      "download",
      `leads-${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getStatusBadge = (statusName: string, stageColor?: string) => {
    if (stageColor) {
      return (
        <Badge
          variant="outline"
          className="font-medium text-xs px-2.5 py-0.5 inline-flex items-center gap-1.5"
          style={{
            borderColor: `${stageColor}40`,
            backgroundColor: `${stageColor}15`,
            color: stageColor,
          }}
        >
          <span
            className="size-1.5 rounded-full shrink-0"
            style={{ backgroundColor: stageColor }}
            aria-hidden
          />
          {statusName}
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="font-normal text-xs">
        {statusName}
      </Badge>
    );
  };

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Leads</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={handleExport}
            disabled={filteredLeads.length === 0}
          >
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button
            size="sm"
            className="gap-2"
            onClick={() => {
              setEditingDeal(null);
              setDealFormOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            New Lead
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-muted-foreground">Total Leads</p>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">
            {totalLeads}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-muted-foreground">Qualified Leads</p>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">
            {qualifiedLeads}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-muted-foreground">Conversion Rate</p>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">
            {conversionRate}%
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-medium text-muted-foreground">New Today</p>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">
            {newToday}
          </p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search leads by name, company, email, phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Single Status Filter Dropdown */}
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onValueChange={(val) => setStatusFilter(val || "All")}
          >
            <SelectTrigger className="w-[180px] h-9 text-xs bg-card border-border">
              <span className="text-muted-foreground mr-1">Status:</span>
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              <SelectItem value="All">All Statuses</SelectItem>
              {statusOptions.map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Leads Table */}
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="font-semibold">Lead Name</TableHead>
              <TableHead className="font-semibold">Contact Info</TableHead>
              <TableHead className="font-semibold">Source</TableHead>
              <TableHead className="font-semibold">Status</TableHead>
              <TableHead className="font-semibold">Assigned Agent</TableHead>
              <TableHead className="font-semibold">Created</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="h-32 text-center text-sm text-muted-foreground"
                >
                  <div className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span>Loading leads...</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : filteredLeads.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="h-32 text-center text-sm text-muted-foreground"
                >
                  No leads found matching your criteria.
                </TableCell>
              </TableRow>
            ) : (
              filteredLeads.map((lead) => (
                <TableRow
                  key={lead.id}
                  className="transition-colors hover:bg-muted/50"
                >
                  <TableCell>
                    <div>
                      <p className="font-medium text-foreground">{lead.name}</p>
                      {lead.company && (
                        <p className="text-xs text-muted-foreground">
                          {lead.company}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-0.5 text-xs text-muted-foreground">
                      {lead.email && (
                        <div className="flex items-center gap-1.5">
                          <Mail className="h-3 w-3" />
                          <span>{lead.email}</span>
                        </div>
                      )}
                      {lead.phone && (
                        <div className="flex items-center gap-1.5">
                          <Phone className="h-3 w-3" />
                          <span>{lead.phone}</span>
                        </div>
                      )}
                      {!lead.email && !lead.phone && <span>-</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-normal text-xs">
                      {lead.source}
                    </Badge>
                  </TableCell>
                  <TableCell>{getStatusBadge(lead.status, lead.statusColor)}</TableCell>
                  <TableCell>
                    <span className="text-sm text-foreground">
                      {lead.assignedTo}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(lead.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="bg-popover border-border">
                        <DropdownMenuItem
                          onClick={() => {
                            if (lead.rawDeal) {
                              setEditingDeal(lead.rawDeal);
                            } else {
                              // Standalone contact -> new deal with this contact
                              setEditingDeal({
                                id: "",
                                user_id: "",
                                pipeline_id: selectedPipelineId,
                                stage_id: stages[0]?.id || "",
                                contact_id: lead.contactId || null,
                                title: lead.name,
                                value: 0,
                                created_at: new Date().toISOString(),
                              });
                            }
                            setDealFormOpen(true);
                          }}
                          className="cursor-pointer gap-2"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          <span>Edit Lead</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Deal / Lead Form Sheet */}
      {selectedPipelineId && (
        <DealForm
          open={dealFormOpen}
          onOpenChange={setDealFormOpen}
          deal={editingDeal}
          pipelineId={selectedPipelineId}
          stages={stages}
          onSaved={() => {
            setDealFormOpen(false);
            loadData();
          }}
        />
      )}
    </div>
  );
}

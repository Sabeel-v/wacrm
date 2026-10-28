"use client";

import { useState } from "react";
import {
  UserCheck,
  Users,
  TrendingUp,
  UserPlus,
  Search,
  Filter,
  Download,
  Plus,
  Mail,
  Phone,
  ArrowUpRight,
  MoreHorizontal,
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

interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  source: "WhatsApp" | "Website" | "Referral" | "Inbound";
  status: "New" | "Contacted" | "Qualified" | "In Negotiation";
  assignedTo: string;
  createdAt: string;
}

const SAMPLE_LEADS: Lead[] = [
  {
    id: "lead-1",
    name: "Sarah Jenkins",
    company: "Apex Media",
    email: "sarah.j@apexmedia.co",
    phone: "+1 (555) 234-8901",
    source: "WhatsApp",
    status: "Qualified",
    assignedTo: "Alex Morgan",
    createdAt: "2 hours ago",
  },
  {
    id: "lead-2",
    name: "David Kim",
    company: "NexGen Logistics",
    email: "dkim@nexgen.io",
    phone: "+1 (555) 789-1234",
    source: "Website",
    status: "New",
    assignedTo: "Jessica Wu",
    createdAt: "4 hours ago",
  },
  {
    id: "lead-3",
    name: "Elena Rostova",
    company: "Nordic Tech Solutions",
    email: "elena@nordictech.eu",
    phone: "+44 20 7946 0912",
    source: "Inbound",
    status: "Contacted",
    assignedTo: "Michael Brown",
    createdAt: "Yesterday",
  },
  {
    id: "lead-4",
    name: "Carlos Mendez",
    company: "Solaria Energy",
    email: "carlos@solaria.es",
    phone: "+34 91 123 4567",
    source: "WhatsApp",
    status: "In Negotiation",
    assignedTo: "Alex Morgan",
    createdAt: "2 days ago",
  },
  {
    id: "lead-5",
    name: "Priya Sharma",
    company: "Venture Wave",
    email: "priya@vwave.in",
    phone: "+91 98765 43210",
    source: "Referral",
    status: "Qualified",
    assignedTo: "Jessica Wu",
    createdAt: "3 days ago",
  },
];

export default function LeadsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("All");

  const filteredLeads = SAMPLE_LEADS.filter((lead) => {
    const matchesSearch =
      lead.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.company.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.phone.includes(searchQuery);

    const matchesStatus =
      statusFilter === "All" || lead.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const getStatusBadge = (status: Lead["status"]) => {
    switch (status) {
      case "New":
        return (
          <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-500">
            New
          </Badge>
        );
      case "Contacted":
        return (
          <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-500">
            Contacted
          </Badge>
        );
      case "Qualified":
        return (
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
            Qualified
          </Badge>
        );
      case "In Negotiation":
        return (
          <Badge variant="outline" className="border-purple-500/30 bg-purple-500/10 text-purple-500">
            In Negotiation
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <div className="flex-1 space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Track, qualify, and convert incoming leads through your sales pipeline.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            Export
          </Button>
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            New Lead
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Total Leads</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Users className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">128</p>
          <p className="mt-1 flex items-center text-xs text-emerald-500 font-medium">
            <ArrowUpRight className="mr-1 h-3.5 w-3.5" /> +12% this month
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Qualified Leads</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500">
              <UserCheck className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">48</p>
          <p className="mt-1 text-xs text-muted-foreground">37.5% qualification rate</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">Conversion Rate</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">24.5%</p>
          <p className="mt-1 flex items-center text-xs text-emerald-500 font-medium">
            <ArrowUpRight className="mr-1 h-3.5 w-3.5" /> +3.2% vs last month
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-muted-foreground">New Today</p>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
              <UserPlus className="h-4 w-4" />
            </div>
          </div>
          <p className="mt-3 text-2xl font-bold tracking-tight text-foreground">7</p>
          <p className="mt-1 text-xs text-muted-foreground">From WhatsApp & Web</p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search leads by name, company, email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {["All", "New", "Contacted", "Qualified", "In Negotiation"].map((status) => (
            <Button
              key={status}
              variant={statusFilter === status ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(status)}
              className="text-xs"
            >
              {status}
            </Button>
          ))}
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
            {filteredLeads.map((lead) => (
              <TableRow key={lead.id} className="transition-colors hover:bg-muted/50">
                <TableCell>
                  <div>
                    <p className="font-medium text-foreground">{lead.name}</p>
                    <p className="text-xs text-muted-foreground">{lead.company}</p>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      <Mail className="h-3 w-3" />
                      <span>{lead.email}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Phone className="h-3 w-3" />
                      <span>{lead.phone}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-normal text-xs">
                    {lead.source}
                  </Badge>
                </TableCell>
                <TableCell>{getStatusBadge(lead.status)}</TableCell>
                <TableCell>
                  <span className="text-sm text-foreground">{lead.assignedTo}</span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">{lead.createdAt}</span>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {filteredLeads.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-sm text-muted-foreground">
                  No leads found matching your criteria.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

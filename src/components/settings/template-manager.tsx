'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  AlertCircle,
  X,
  Pencil,
  RotateCcw,
  Upload,
  Search,
  Flag,
  Tag,
  Copy,
  Check,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media';
import {
  MEDIA_HEADER_SPECS,
  isMediaHeaderKind,
  type MediaHeaderKind,
} from '@/lib/whatsapp/media-header-types';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
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
import { cn } from '@/lib/utils';
import type {
  MessageTemplate,
  MessageTemplateStatus,
  TemplateButton,
  TemplateSampleValues,
} from '@/types';
import { templateStatusConfig } from '@/lib/template-status';
import {
  extractVariableIndices,
  TEMPLATE_LIMITS,
} from '@/lib/whatsapp/template-validators';

const STATUS_DOT_COLORS: Record<string, string> = {
  APPROVED: 'bg-emerald-500',
  PENDING: 'bg-amber-500',
  REJECTED: 'bg-rose-500',
  PAUSED: 'bg-orange-500',
  DRAFT: 'bg-slate-400',
  DISABLED: 'bg-rose-700',
};

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English (en)',
  en_US: 'English (en)',
  en_GB: 'English (en)',
  es: 'Spanish (es)',
  es_ES: 'Spanish (es)',
  es_MX: 'Spanish (es)',
  pt: 'Portuguese (pt)',
  pt_BR: 'Portuguese (pt)',
  pt_PT: 'Portuguese (pt)',
  fr: 'French (fr)',
  fr_FR: 'French (fr)',
  de: 'German (de)',
  it: 'Italian (it)',
  nl: 'Dutch (nl)',
  pl: 'Polish (pl)',
  ru: 'Russian (ru)',
  tr: 'Turkish (tr)',
  hi: 'Hindi (hi)',
  ar: 'Arabic (ar)',
  ko: 'Korean (ko)',
  ja: 'Japanese (ja)',
  zh: 'Chinese (zh)',
  id: 'Indonesian (id)',
};

function formatLanguageName(lang?: string | null): string {
  if (!lang) return 'English (en)';
  if (LANGUAGE_DISPLAY_NAMES[lang]) return LANGUAGE_DISPLAY_NAMES[lang];
  const base = lang.split('_')[0].toLowerCase();
  if (LANGUAGE_DISPLAY_NAMES[base]) return LANGUAGE_DISPLAY_NAMES[base];
  return `${lang} (${lang})`;
}

function getTemplateTitle(name: string): string {
  if (name.includes('_') && !name.startsWith('browse_')) {
    return name.replace(/_/g, ' ').toUpperCase();
  }
  return name;
}

function formatLastSyncedDate(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear().toString().slice(-2);
  return `${hour12}:${minutes} ${ampm}, ${day}/${month}/${year}`;
}

const CATEGORIES = ['Marketing', 'Utility', 'Authentication'] as const;
type HeaderFormat = 'none' | 'text' | 'image' | 'video' | 'document';
const HEADER_FORMATS: HeaderFormat[] = ['none', 'text', 'image', 'video', 'document'];

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-600/20 text-purple-400 border-purple-600/30',
  Utility: 'bg-blue-600/20 text-blue-400 border-blue-600/30',
  Authentication: 'bg-amber-600/20 text-amber-400 border-amber-600/30',
};

interface TemplateFormData {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  header_format: HeaderFormat;
  header_content: string;
  header_media_url: string;
  header_sample: string;
  body_text: string;
  body_samples: string[];
  footer_text: string;
  buttons: TemplateButton[];
}

const emptyForm: TemplateFormData = {
  name: '',
  category: 'Marketing',
  language: 'en_US',
  header_format: 'none',
  header_content: '',
  header_media_url: '',
  header_sample: '',
  body_text: '',
  body_samples: [],
  footer_text: '',
  buttons: [],
};

const COMMON_LANGUAGE_CODES = [
  'en_US',
  'en_GB',
  'en',
  'es',
  'es_ES',
  'es_MX',
  'fr',
  'fr_FR',
  'de',
  'it',
  'pt_BR',
  'pt_PT',
  'nl',
  'pl',
  'ru',
  'tr',
  'lt',
];

function emptyButton(type: TemplateButton['type']): TemplateButton {
  switch (type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: '' };
    case 'URL':
      return { type: 'URL', text: '', url: '' };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: '', phone_number: '' };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: '', example: '' };
  }
}

export function TemplateManager() {
  const t = useTranslations('Settings.templates');
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [profiles, setProfiles] = useState<{ user_id: string; full_name?: string | null; email?: string | null }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const [lastSyncedTime, setLastSyncedTime] = useState<string>('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [form, setForm] = useState<TemplateFormData>(emptyForm);
  // Non-null when the dialog is editing an existing row — switches the
  // submit handler from POST /submit to PATCH /[id] and changes the
  // dialog title + CTA. Set to the template id to pre-fill from a row.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Template selected for the confirm-delete dialog. The destructive
  // action goes through this two-step so a slip on the trash icon
  // doesn't take the template off Meta as well as locally.
  const [templateToDelete, setTemplateToDelete] =
    useState<MessageTemplate | null>(null);
  // Header-media upload (image #230; video/document #562). Uploads to the
  // account-scoped chat-media bucket and stores the public URL in
  // header_media_url; the submit route turns that into a Meta
  // Resumable-Upload handle.
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const headerFileRef = useRef<HTMLInputElement>(null);

  // Body variable indices — `[1, 2, 3]` for "{{1}} {{2}} {{3}}". We
  // re-run the extractor on every render to keep the sample-value rows
  // in sync with what the user typed.
  const bodyVarCount = useMemo(
    () => extractVariableIndices(form.body_text).length,
    [form.body_text],
  );
  const headerVarCount = useMemo(
    () =>
      form.header_format === 'text'
        ? extractVariableIndices(form.header_content).length
        : 0,
    [form.header_format, form.header_content],
  );

  // Resize body_samples so it always has exactly bodyVarCount entries.
  // (We mutate via setForm in an effect so React owns the state.)
  useEffect(() => {
    setForm((prev) => {
      if (prev.body_samples.length === bodyVarCount) return prev;
      const next = prev.body_samples.slice(0, bodyVarCount);
      while (next.length < bodyVarCount) next.push('');
      return { ...prev, body_samples: next };
    });
  }, [bodyVarCount]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchTemplates(user.id);

    // Initial last-synced time
    try {
      const stored = localStorage.getItem('templates_last_synced');
      if (stored) {
        setLastSyncedTime(formatLastSyncedDate(new Date(stored)));
      } else {
        const now = new Date();
        setLastSyncedTime(formatLastSyncedDate(now));
        localStorage.setItem('templates_last_synced', now.toISOString());
      }
    } catch {
      setLastSyncedTime(formatLastSyncedDate(new Date()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function fetchTemplates(userId: string) {
    try {
      setLoading(true);
      const [templatesRes, profilesRes] = await Promise.all([
        supabase
          .from('message_templates')
          .select('*')
          .order('created_at', { ascending: false }),
        supabase
          .from('profiles')
          .select('user_id, full_name, email'),
      ]);

      if (templatesRes.error) throw templatesRes.error;
      setTemplates(templatesRes.data || []);
      if (profilesRes.data) {
        setProfiles(profilesRes.data);
      }
    } catch (err) {
      console.error('Failed to fetch templates:', err);
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }

  const profilesMap = useMemo(() => {
    const map = new Map<string, string>();
    profiles.forEach((p) => {
      const name = p.full_name?.trim() || p.email?.split('@')[0] || p.email || 'User';
      map.set(p.user_id, name);
    });
    return map;
  }, [profiles]);

  const filteredTemplates = useMemo(() => {
    return templates.filter((tpl) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        if (!tpl.name.toLowerCase().includes(q)) return false;
      }
      if (statusFilter !== 'ALL') {
        const statusKey = (tpl.status || 'DRAFT').toUpperCase();
        if (statusKey !== statusFilter.toUpperCase()) return false;
      }
      if (categoryFilter !== 'ALL') {
        if (tpl.category.toUpperCase() !== categoryFilter.toUpperCase()) return false;
      }
      return true;
    });
  }, [templates, searchQuery, statusFilter, categoryFilter]);

  const hasActiveFilters =
    searchQuery.trim() !== '' || statusFilter !== 'ALL' || categoryFilter !== 'ALL';

  function handleCopy(name: string, e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(name);
    setCopiedName(name);
    toast.success(`Copied "${name}" to clipboard`);
    setTimeout(() => {
      setCopiedName((curr) => (curr === name ? null : curr));
    }, 2000);
  }

  function buildSubmitPayload() {
    const sample_values: TemplateSampleValues = {};
    if (form.body_samples.some((v) => v.trim())) {
      sample_values.body = form.body_samples.map((v) => v.trim());
    }
    if (form.header_format === 'text' && form.header_sample.trim()) {
      sample_values.header = [form.header_sample.trim()];
    }

    return {
      name: form.name.trim(),
      category: form.category,
      language: form.language.trim() || 'en_US',
      header_type: form.header_format === 'none' ? undefined : form.header_format,
      header_content:
        form.header_format === 'text' ? form.header_content.trim() : undefined,
      header_media_url:
        form.header_format !== 'none' && form.header_format !== 'text'
          ? form.header_media_url.trim() || undefined
          : undefined,
      body_text: form.body_text.trim(),
      footer_text: form.footer_text.trim() || undefined,
      buttons: form.buttons.length > 0 ? form.buttons : undefined,
      sample_values:
        Object.keys(sample_values).length > 0 ? sample_values : undefined,
    };
  }

  function openEdit(template: MessageTemplate) {
    setEditingId(template.id);
    setForm({
      name: template.name,
      category: template.category,
      language: template.language || 'en_US',
      header_format: (template.header_type ?? 'none') as HeaderFormat,
      header_content: template.header_content ?? '',
      header_media_url: template.header_media_url ?? '',
      header_sample: template.sample_values?.header?.[0] ?? '',
      body_text: template.body_text,
      body_samples: template.sample_values?.body ?? [],
      footer_text: template.footer_text ?? '',
      buttons: template.buttons ?? [],
    });
    setDialogOpen(true);
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  async function handleSubmit() {
    // AUTHENTICATION is blocked by the persistent banner + disabled
    // submit button; this is a defensive second line of defense.
    if (form.category === 'Authentication') return;
    try {
      setSubmitting(true);
      const isEdit = editingId !== null;
      const url = isEdit
        ? `/api/whatsapp/templates/${editingId}`
        : '/api/whatsapp/templates/submit';
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSubmitPayload()),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data?.error || t(isEdit ? 'editFailedHttp' : 'submitFailedHttp', { status: res.status }),
        );
      }
      // Refresh first, then close — re-opening the dialog
      // immediately should not show a stale list.
      if (user) await fetchTemplates(user.id);
      toast.success(
        data.dry_run
          ? isEdit
            ? t('toastSaveEditDry')
            : t('toastSaveNewDry')
          : isEdit
            ? t('toastSubmitEditSuccess')
            : t('toastSubmitNewSuccess'),
      );
      setDialogOpen(false);
      setForm(emptyForm);
      setEditingId(null);
    } catch (err) {
      console.error('Submit error:', err);
      toast.error(err instanceof Error ? err.message : t('toastSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSyncFromMeta() {
    if (!user) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Sync failed (HTTP ${res.status})`);
      }
      toast.success(
        t('toastSyncCount', { total: data.total }) +
          (data.inserted || data.updated
            ? t('toastSyncDetails', { inserted: data.inserted, updated: data.updated })
            : ''),
      );
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const preview = data.errors.slice(0, 3).map(
          (e: { name: string; language: string; message: string }) =>
            `${e.name} (${e.language})`,
        );
        const suffix =
          data.errors.length > 3 ? `, +${data.errors.length - 3} more` : '';
        toast.error(t('toastSyncFailed', { preview: preview.join(', ') + suffix }));
      }
      if (data.truncated) {
        // Use error (not warning) so the message survives long
        // enough to read — sonner's `warning` auto-dismisses on
        // the same short timer as `success`.
        toast.error(
          t('toastSyncTruncated'),
          { duration: 10000 },
        );
      }
      const syncNow = new Date();
      setLastSyncedTime(formatLastSyncedDate(syncNow));
      try {
        localStorage.setItem('templates_last_synced', syncNow.toISOString());
      } catch {
        // ignore
      }
      await fetchTemplates(user.id);
    } catch (err) {
      console.error('Template sync error:', err);
      toast.error(err instanceof Error ? err.message : t('toastSyncError'));
    } finally {
      setSyncing(false);
    }
  }

  async function confirmDelete() {
    const target = templateToDelete;
    if (!target || deletingId) return;
    setDeletingId(target.id);
    try {
      // Route handler scopes the Meta delete via hsm_id (so sibling
      // language variants survive) and falls through to remove the
      // local row. Local-only rows skip the Meta call.
      const res = await fetch(`/api/whatsapp/templates/${target.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Delete failed (HTTP ${res.status})`);
      }
      toast.success(t('toastDeleteSuccess'));
      setTemplates((prev) => prev.filter((t) => t.id !== target.id));
      setTemplateToDelete(null);
    } catch (err) {
      console.error('Delete error:', err);
      toast.error(err instanceof Error ? err.message : t('toastDeleteError'));
    } finally {
      setDeletingId(null);
    }
  }

  // The patch type unions every field across button variants. The
  // conditional rendering below ensures only fields valid for the
  // current button's `type` reach this function, so the runtime
  // assertion + per-type spread preserves discriminated-union
  // invariants without forcing every call site to thread the type
  // through generics (which TS can't infer from a partial literal).
  type ButtonPatch = {
    text?: string;
    url?: string;
    phone_number?: string;
    example?: string;
  };
  function updateButton(index: number, patch: ButtonPatch) {
    setForm((prev) => {
      const current = prev.buttons[index];
      if (!current) return prev;
      const next = [...prev.buttons];
      // Per-variant spread keeps the discriminant pinned. Switch
      // exhaustiveness is enforced by TypeScript.
      switch (current.type) {
        case 'QUICK_REPLY':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
          };
          break;
        case 'URL':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
            ...(patch.url !== undefined && { url: patch.url }),
            ...(patch.example !== undefined && { example: patch.example }),
          };
          break;
        case 'PHONE_NUMBER':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
            ...(patch.phone_number !== undefined && {
              phone_number: patch.phone_number,
            }),
          };
          break;
        case 'COPY_CODE':
          next[index] = {
            ...current,
            ...(patch.text !== undefined && { text: patch.text }),
            ...(patch.example !== undefined && { example: patch.example }),
          };
          break;
      }
      return { ...prev, buttons: next };
    });
  }

  function changeButtonType(index: number, type: TemplateButton['type']) {
    setForm((prev) => {
      const next = [...prev.buttons];
      next[index] = emptyButton(type);
      return { ...prev, buttons: next };
    });
  }

  function removeButton(index: number) {
    setForm((prev) => ({
      ...prev,
      buttons: prev.buttons.filter((_, i) => i !== index),
    }));
  }

  function addButton() {
    if (form.buttons.length >= TEMPLATE_LIMITS.maxButtonsTotal) return;
    setForm((prev) => ({
      ...prev,
      buttons: [...prev.buttons, emptyButton('QUICK_REPLY')],
    }));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const headerNeedsMedia =
    form.header_format !== 'none' && form.header_format !== 'text';
  const headerMediaKind: MediaHeaderKind | null = isMediaHeaderKind(
    form.header_format,
  )
    ? form.header_format
    : null;

  // Per-kind copy for the file picker. Kept as explicit key maps (not
  // `t(\`upload${kind}\`)`) so the catalogue scanner can see every key.
  const uploadLabelKey = {
    image: 'uploadImage',
    video: 'uploadVideo',
    document: 'uploadDocument',
  } as const;
  const uploadHintKey = {
    image: 'uploadHint',
    video: 'uploadHintVideo',
    document: 'uploadHintDocument',
  } as const;
  const invalidTypeKey = {
    image: 'toastInvalidImage',
    video: 'toastInvalidVideo',
    document: 'toastInvalidDocument',
  } as const;

  async function handleHeaderMediaFile(file: File, kind: MediaHeaderKind) {
    if (!MEDIA_HEADER_SPECS[kind].mimeTypes.includes(file.type)) {
      toast.error(t(invalidTypeKey[kind]));
      return;
    }
    // The upload lands in the chat-media bucket, whose 16 MB ceiling is
    // below Meta's 100 MB document cap — so this is the bucket-side
    // limit, not Meta's. A larger document can still be pasted as a link.
    const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (file.size > maxBytes) {
      toast.error(
        t('toastMediaTooLarge', {
          size: (file.size / 1024 / 1024).toFixed(1),
          max: Math.round(maxBytes / 1024 / 1024),
        }),
      );
      return;
    }
    setUploadingHeader(true);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      setForm((f) => ({ ...f, header_media_url: publicUrl }));
      toast.success(t('toastUploadSuccess'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('toastUploadFailed'));
    } finally {
      setUploadingHeader(false);
    }
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      {/* Top Filter and Action Bar */}
      <div className="flex flex-wrap items-center gap-2.5">
        {/* Search by template name */}
        <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search a template by name"
            className="h-9 pl-9 pr-8 text-xs bg-card border-border"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Status Dropdown */}
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
          <SelectTrigger className="h-9 min-w-[120px] text-xs bg-card border-border">
            <Flag className="size-3.5 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Statuses</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="DRAFT">Draft</SelectItem>
            <SelectItem value="PAUSED">Paused</SelectItem>
          </SelectContent>
        </Select>

        {/* Category Dropdown */}
        <Select value={categoryFilter} onValueChange={(v) => v && setCategoryFilter(v)}>
          <SelectTrigger className="h-9 min-w-[130px] text-xs bg-card border-border">
            <Tag className="size-3.5 mr-1.5 text-muted-foreground" />
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Categories</SelectItem>
            <SelectItem value="Marketing">Marketing</SelectItem>
            <SelectItem value="Utility">Utility</SelectItem>
            <SelectItem value="Authentication">Authentication</SelectItem>
          </SelectContent>
        </Select>

        {/* Reset filter button */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchQuery('');
              setStatusFilter('ALL');
              setCategoryFilter('ALL');
            }}
            className="h-9 text-xs text-muted-foreground hover:text-foreground px-2"
          >
            Reset
          </Button>
        )}

        {/* New Template CTA */}
        <div className="ml-auto">
          <Button
            onClick={openCreate}
            className="h-9 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4 mr-1.5" />
            {t('newTemplate')}
          </Button>
        </div>
      </div>

      {/* Sync Status Row */}
      <div className="flex items-center justify-end gap-3 pt-0.5">
        {lastSyncedTime && (
          <span className="text-xs text-muted-foreground">
            Last synced on: {lastSyncedTime}
          </span>
        )}
        <Button
          variant="outline"
          onClick={handleSyncFromMeta}
          disabled={syncing}
          title={t('syncTitle')}
          className="h-8 border-emerald-600/60 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-500/60 dark:text-emerald-400 dark:hover:bg-emerald-950/20 text-xs px-3 font-medium gap-1.5"
        >
          <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />
          Sync
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">{t('noTemplates')}</p>
            <p className="text-muted-foreground text-xs mt-1">
              {t('createFirst')}
            </p>
          </CardContent>
        </Card>
      ) : filteredTemplates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">No templates match the selected filters.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('ALL');
                setCategoryFilter('ALL');
              }}
              className="mt-3 text-xs"
            >
              Reset filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="font-semibold text-foreground py-3.5 px-4 text-xs sm:text-sm">
                  Template Name
                </TableHead>
                <TableHead className="font-semibold text-foreground py-3.5 px-4 text-xs sm:text-sm">
                  Status
                </TableHead>
                <TableHead className="font-semibold text-foreground py-3.5 px-4 text-xs sm:text-sm">
                  Category
                </TableHead>
                <TableHead className="font-semibold text-foreground py-3.5 px-4 text-xs sm:text-sm">
                  Language(s)
                </TableHead>
                <TableHead className="font-semibold text-foreground py-3.5 px-4 text-xs sm:text-sm">
                  Created By
                </TableHead>
                <TableHead className="w-24 text-right py-3.5 px-4 font-semibold text-foreground text-xs sm:text-sm">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTemplates.map((template) => {
                const statusKey = (template.status || 'DRAFT') as MessageTemplateStatus;
                const statusInfo =
                  templateStatusConfig[statusKey] || { label: statusKey, classes: '' };
                const dotColor = STATUS_DOT_COLORS[statusKey] || 'bg-slate-400';
                const displayName = getTemplateTitle(template.name);
                const creatorName =
                  profilesMap.get(template.user_id) ||
                  user?.user_metadata?.full_name ||
                  'Admin';

                return (
                  <TableRow
                    key={template.id}
                    className="border-border hover:bg-muted/40 transition-colors"
                  >
                    {/* Template Name */}
                    <TableCell className="py-3.5 px-4">
                      <div className="space-y-0.5">
                        <div className="font-medium text-foreground text-sm">
                          {displayName}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{template.name}</span>
                          <button
                            type="button"
                            onClick={(e) => handleCopy(template.name, e)}
                            className="text-muted-foreground/70 hover:text-foreground transition-colors p-0.5"
                            title="Copy template name"
                          >
                            {copiedName === template.name ? (
                              <Check className="size-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </button>
                        </div>
                        {(template.rejection_reason || template.submission_error) && (
                          <div className="flex items-center gap-1 text-[11px] text-red-500 pt-0.5">
                            <AlertCircle className="size-3 shrink-0" />
                            <span className="truncate max-w-[280px]">
                              {template.rejection_reason || template.submission_error}
                            </span>
                          </div>
                        )}
                      </div>
                    </TableCell>

                    {/* Status with dot */}
                    <TableCell className="py-3.5 px-4">
                      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                        <span className={cn('size-2 rounded-full', dotColor)} />
                        {statusInfo.label}
                      </span>
                    </TableCell>

                    {/* Category */}
                    <TableCell className="py-3.5 px-4 text-sm text-foreground">
                      {template.category}
                    </TableCell>

                    {/* Language(s) */}
                    <TableCell className="py-3.5 px-4 text-sm text-foreground">
                      {formatLanguageName(template.language)}
                    </TableCell>

                    {/* Created By */}
                    <TableCell className="py-3.5 px-4 text-sm text-foreground">
                      {creatorName}
                    </TableCell>

                    {/* Actions */}
                    <TableCell className="py-3.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {statusKey === 'APPROVED' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(template)}
                            title={t('editTitle')}
                            aria-label={t('editLabel')}
                            className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-7 px-2 text-xs"
                          >
                            <Pencil className="size-3 mr-1" />
                            {t('edit')}
                          </Button>
                        )}
                        {(statusKey === 'REJECTED' || statusKey === 'PAUSED') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(template)}
                            title={t('resubmitTitle')}
                            aria-label={t('resubmitLabel')}
                            className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-7 px-2 text-xs"
                          >
                            <RotateCcw className="size-3 mr-1" />
                            {t('resubmit')}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setTemplateToDelete(template)}
                          disabled={deletingId === template.id}
                          aria-label={t('deleteAria', { name: template.name })}
                          className="text-muted-foreground hover:text-red-400 hover:bg-red-950/20 size-7"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditingId(null);
            setForm(emptyForm);
          }
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {editingId ? t('dialogEditTitle') : t('dialogNewTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {editingId
                ? t('dialogEditDesc')
                : t('dialogNewDesc')}
            </DialogDescription>
          </DialogHeader>

          {form.category === 'Authentication' && (
            <div className="flex items-start gap-2 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
              <AlertCircle className="size-4 mt-0.5 shrink-0" />
              <p>{t.rich('authWarning', { bold: (chunks) => <strong>{chunks}</strong> })}</p>
            </div>
          )}

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('templateName')}</Label>
              <Input
                placeholder={t('namePlaceholder')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={editingId !== null}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:opacity-60 disabled:cursor-not-allowed"
              />
              <p className="text-[11px] text-muted-foreground">
                {editingId
                  ? t('nameFixed')
                  : t('nameHint')}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('category')}</Label>
                <Select
                  value={form.category}
                  onValueChange={(val) =>
                    setForm({
                      ...form,
                      category: val as MessageTemplate['category'],
                    })
                  }
                >
                  <SelectTrigger className="w-full bg-muted border-border text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-border">
                    {CATEGORIES.map((cat) => (
                      <SelectItem
                        key={cat}
                        value={cat}
                        className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                      >
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('language')}</Label>
                <Input
                  list="template-language-codes"
                  placeholder="en_US"
                  value={form.language}
                  onChange={(e) =>
                    setForm({ ...form, language: e.target.value })
                  }
                  disabled={editingId !== null}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:opacity-60 disabled:cursor-not-allowed"
                />
                <datalist id="template-language-codes">
                  {COMMON_LANGUAGE_CODES.map((code) => (
                    <option key={code} value={code} />
                  ))}
                </datalist>
                <p className="text-[11px] text-muted-foreground">
                  {editingId ? (
                    t('langFixed')
                  ) : (
                    <span>{t.rich('langHint', { code: (chunks) => <code>{chunks}</code> })}</span>
                  )}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('header')}</Label>
              <Select
                value={form.header_format}
                onValueChange={(val) =>
                  // Preserve header_content, header_media_url, and
                  // header_sample across format switches. The submit
                  // payload builder only reads the field that matches
                  // the active format, so an orphan value on a hidden
                  // field is harmless — and keeping it lets the user
                  // switch formats to compare without losing typing.
                  setForm({
                    ...form,
                    header_format: (val || 'none') as HeaderFormat,
                  })
                }
              >
                <SelectTrigger className="w-full bg-muted border-border text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover border-border">
                  {HEADER_FORMATS.map((type) => (
                    <SelectItem
                      key={type}
                      value={type}
                      className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                    >
                      {type === 'none'
                        ? t('headerNone')
                        : type === 'text'
                          ? t('headerText')
                          : type === 'image'
                            ? t('headerImage')
                            : type === 'video'
                              ? t('headerVideo')
                              : t('headerDocument')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {form.header_format === 'text' && (
                <div className="space-y-2 mt-2">
                  <Input
                    id="template-header-text"
                    aria-label={t('headerTextLabel')}
                    placeholder={t.raw('headerTextPlaceholder')}
                    value={form.header_content}
                    onChange={(e) =>
                      setForm({ ...form, header_content: e.target.value })
                    }
                    maxLength={TEMPLATE_LIMITS.headerTextMaxLength}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                  {headerVarCount > 0 && (
                    <Input
                      id="template-header-sample"
                      aria-label={t('headerSampleAria')}
                      placeholder={t.raw('headerSamplePlaceholder')}
                      value={form.header_sample}
                      onChange={(e) =>
                        setForm({ ...form, header_sample: e.target.value })
                      }
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                    />
                  )}
                </div>
              )}

              {headerNeedsMedia && (
                <div className="space-y-2 mt-2">
                  {headerMediaKind && (
                    <div className="flex items-center gap-2">
                      <input
                        ref={headerFileRef}
                        type="file"
                        accept={MEDIA_HEADER_SPECS[headerMediaKind].mimeTypes.join(',')}
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleHeaderMediaFile(f, headerMediaKind);
                          e.target.value = '';
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={uploadingHeader}
                        onClick={() => headerFileRef.current?.click()}
                      >
                        {uploadingHeader ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        {t(uploadLabelKey[headerMediaKind])}
                      </Button>
                      <span className="text-[11px] text-muted-foreground">
                        {t(uploadHintKey[headerMediaKind])}
                      </span>
                    </div>
                  )}
                  <Input
                    placeholder={t('mediaUrlPlaceholder', { format: form.header_format })}
                    value={form.header_media_url}
                    onChange={(e) =>
                      setForm({ ...form, header_media_url: e.target.value })
                    }
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                  {form.header_format === 'image' && form.header_media_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={form.header_media_url}
                      alt="Header sample"
                      className="max-h-28 rounded-md border border-border object-contain"
                    />
                  )}
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {form.header_format === 'image'
                      ? t('imageHint')
                      : t('mediaHint')}
                    {form.header_format === 'video' &&
                      t('videoHint')}
                    {form.header_format === 'document' &&
                      t('documentHint')}
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('bodyText')}</Label>
              <Textarea
                placeholder={t.raw('bodyPlaceholder')}
                value={form.body_text}
                onChange={(e) =>
                  setForm({ ...form, body_text: e.target.value })
                }
                rows={4}
                maxLength={TEMPLATE_LIMITS.bodyMaxLength}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground resize-none"
              />
              <p className="text-[11px] text-muted-foreground">
                {t.raw('bodyHint')}
              </p>

              {bodyVarCount > 0 && (
                <div className="space-y-1.5 pt-1">
                  <Label className="text-[11px] text-muted-foreground">
                    {t('sampleValues')}
                  </Label>
                  {form.body_samples.map((val, i) => {
                    const inputId = `template-body-sample-${i}`;
                    return (
                      <Input
                        key={i}
                        id={inputId}
                        aria-label={t('sampleAria', { var: `{{${i + 1}}}` })}
                        placeholder={t('samplePlaceholder', { var: `{{${i + 1}}}` })}
                        value={val}
                        onChange={(e) => {
                          const next = [...form.body_samples];
                          next[i] = e.target.value;
                          setForm({ ...form, body_samples: next });
                        }}
                        className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                      />
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('footer')}</Label>
              <Input
                placeholder={t('footerPlaceholder')}
                value={form.footer_text}
                onChange={(e) =>
                  setForm({ ...form, footer_text: e.target.value })
                }
                maxLength={TEMPLATE_LIMITS.footerMaxLength}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-muted-foreground">{t('buttons')}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addButton}
                  disabled={form.buttons.length >= TEMPLATE_LIMITS.maxButtonsTotal}
                  className="border-border bg-transparent text-muted-foreground hover:bg-muted h-7 text-xs"
                >
                  <Plus className="size-3" />
                  {t('addButton')}
                </Button>
              </div>
              {form.buttons.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {t('buttonsLimit', { max: TEMPLATE_LIMITS.maxButtonsTotal })}
                </p>
              ) : (
                <div className="space-y-2">
                  {form.buttons.map((btn, i) => (
                    <div
                      key={i}
                      className="space-y-2 rounded border border-border bg-muted/50 p-2"
                    >
                      <div className="flex items-center gap-2">
                        <Select
                          value={btn.type}
                          onValueChange={(val) => {
                            // Same null guard as the Header Select
                            // (per PR 148): @base-ui Select fires
                            // onValueChange(null) on deselect.
                            if (!val) return;
                            changeButtonType(i, val as TemplateButton['type']);
                          }}
                        >
                          <SelectTrigger className="w-40 bg-muted border-border text-foreground h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-popover border-border">
                            <SelectItem
                              value="QUICK_REPLY"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnQuickReply')}
                            </SelectItem>
                            <SelectItem
                              value="URL"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnUrl')}
                            </SelectItem>
                            <SelectItem
                              value="PHONE_NUMBER"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnPhone')}
                            </SelectItem>
                            <SelectItem
                              value="COPY_CODE"
                              className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                            >
                              {t('btnCopyCode')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder={t('btnLabelPlaceholder')}
                          value={btn.text}
                          maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
                          onChange={(e) =>
                            updateButton(i, { text: e.target.value })
                          }
                          className="flex-1 bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeButton(i)}
                          className="text-muted-foreground hover:text-red-400 hover:bg-red-950/30 size-7"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                      {btn.type === 'URL' && (
                        <div className="space-y-1 pl-1">
                          <Input
                            placeholder={t.raw('urlPlaceholder')}
                            value={btn.url}
                            onChange={(e) =>
                              updateButton(i, { url: e.target.value })
                            }
                            className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                          />
                          {extractVariableIndices(btn.url).length > 0 && (
                            <Input
                              placeholder={t.raw('urlSamplePlaceholder')}
                              value={btn.example ?? ''}
                              onChange={(e) =>
                                updateButton(i, { example: e.target.value })
                              }
                              className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                            />
                          )}
                        </div>
                      )}
                      {btn.type === 'PHONE_NUMBER' && (
                        <Input
                          placeholder={t('phonePlaceholder')}
                          value={btn.phone_number}
                          onChange={(e) =>
                            updateButton(i, { phone_number: e.target.value })
                          }
                          className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                        />
                      )}
                      {btn.type === 'COPY_CODE' && (
                        <Input
                          placeholder={t('codePlaceholder')}
                          value={btn.example}
                          onChange={(e) =>
                            updateButton(i, { example: e.target.value })
                          }
                          className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-xs"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || form.category === 'Authentication'}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {editingId ? t('saving') : t('submitting')}
                </>
              ) : editingId ? (
                t('saveResubmit')
              ) : (
                t('submitApproval')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm-delete dialog. Surfacing the meta_template_id case
          separately so users understand a real Meta delete is happening,
          not just a local cleanup. */}
      <Dialog
        open={templateToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setTemplateToDelete(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteDialogTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {templateToDelete?.meta_template_id
                ? t('deleteMetaDesc', { name: templateToDelete.name })
                : t('deleteLocalDesc', { name: templateToDelete?.name || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setTemplateToDelete(null)}
              disabled={deletingId !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={confirmDelete}
              disabled={deletingId !== null}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deletingId !== null ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('delete')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

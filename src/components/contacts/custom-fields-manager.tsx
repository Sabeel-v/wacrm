'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type { CustomField, CustomFieldType } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Plus, Trash2, Settings2, Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getFieldOptions, getFieldType } from './custom-field-input';

interface CustomFieldsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog wrapper around {@link CustomFieldsPanel}, used on the Contacts page.
 * The same panel is rendered inline under Settings → Custom Fields, so the
 * editing UI lives in one place. Radix unmounts the dialog content on close,
 * so the panel remounts (and refetches) on each open.
 */
export function CustomFieldsManager({
  open,
  onOpenChange,
}: CustomFieldsManagerProps) {
  const t = useTranslations('Contacts.customFields');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('desc')}
          </DialogDescription>
        </DialogHeader>
        <CustomFieldsPanel />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Create / rename / configure / delete account-wide custom contact field definitions.
 * Supports text, number, email, phone, date, and dropdown fields.
 * Admin+ gated by the caller — the `custom_fields` RLS also rejects non-admin writes as defense in depth.
 */
export function CustomFieldsPanel() {
  const t = useTranslations('Contacts.customFields');
  const supabase = createClient();
  const { user, accountId } = useAuth();

  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<CustomFieldType>('text');
  const [newOptions, setNewOptions] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchFields = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data } = await supabase
      .from('custom_fields')
      .select('*')
      .order('field_name');
    setFields((data as CustomField[] | null) ?? []);
    setLoading(false);
  }, [supabase, accountId]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchFields();
    }
  }, [accountId, fetchFields]);

  /** Case-insensitive name clash within the loaded list. */
  function isDuplicate(name: string, exceptId?: string): boolean {
    const lower = name.toLowerCase();
    return fields.some(
      (f) => f.id !== exceptId && f.field_name.toLowerCase() === lower
    );
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (!accountId || !user) {
      toast.error(t('toastNoAccount'));
      return;
    }
    if (isDuplicate(name)) {
      toast.error(t('toastDuplicate', { name }));
      return;
    }

    const options =
      newType === 'dropdown'
        ? newOptions
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    setCreating(true);
    const { error } = await supabase.from('custom_fields').insert({
      field_name: name,
      field_type: newType,
      field_options: options.length > 0 ? { options } : null,
      user_id: user.id,
      account_id: accountId,
    });
    setCreating(false);

    if (error) {
      toast.error(t('toastCreateFailed'));
      return;
    }
    toast.success(t('toastCreated', { name }));
    setNewName('');
    setNewType('text');
    setNewOptions('');
    await fetchFields();
  }

  async function handleRename(
    field: CustomField,
    nextName: string
  ): Promise<boolean> {
    const name = nextName.trim();
    if (!name || name === field.field_name) return true;
    if (isDuplicate(name, field.id)) {
      toast.error(t('toastDuplicate', { name }));
      return false;
    }
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .update({ field_name: name })
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(t('toastRenameFailed'));
      return false;
    }
    await fetchFields();
    return true;
  }

  async function handleUpdateConfig(
    field: CustomField,
    nextType: string,
    options: string[]
  ): Promise<boolean> {
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .update({
        field_type: nextType,
        field_options: options.length > 0 ? { options } : null,
      })
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(t('toastUpdateFailed'));
      return false;
    }
    toast.success(t('toastCreated', { name: field.field_name }));
    await fetchFields();
    return true;
  }

  async function handleDelete(field: CustomField) {
    if (
      !window.confirm(
        t('deleteConfirm', { name: field.field_name })
      )
    ) {
      return;
    }
    setBusyId(field.id);
    const { error } = await supabase
      .from('custom_fields')
      .delete()
      .eq('id', field.id);
    setBusyId(null);
    if (error) {
      toast.error(t('toastDeleteFailed'));
      return;
    }
    toast.success(t('toastDeleted', { name: field.field_name }));
    await fetchFields();
  }

  return (
    <div className="space-y-4">
      {/* Create Section */}
      <div className="space-y-2 rounded-lg border border-border/70 p-3 bg-muted/20">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newType !== 'dropdown') {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder={t('fieldName')}
            className="bg-muted text-foreground flex-1"
          />

          <Select
            value={newType}
            onValueChange={(v) => v && setNewType(v as CustomFieldType)}
          >
            <SelectTrigger className="w-full sm:w-36 bg-muted border-border text-foreground">
              <SelectValue placeholder={t('typeLabel')} />
            </SelectTrigger>
            <SelectContent className="bg-popover border-border text-popover-foreground">
              <SelectItem value="text">{t('typeText')}</SelectItem>
              <SelectItem value="dropdown">{t('typeDropdown')}</SelectItem>
              <SelectItem value="number">{t('typeNumber')}</SelectItem>
              <SelectItem value="email">{t('typeEmail')}</SelectItem>
              <SelectItem value="phone">{t('typePhone')}</SelectItem>
              <SelectItem value="date">{t('typeDate')}</SelectItem>
            </SelectContent>
          </Select>

          <Button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {t('addField')}
          </Button>
        </div>

        {newType === 'dropdown' && (
          <div className="pt-1">
            <Input
              value={newOptions}
              onChange={(e) => setNewOptions(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder={t('optionsPlaceholder')}
              className="bg-muted text-foreground text-xs"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Separate dropdown choices with commas (e.g. Plus One, Plus Two, 10th)
            </p>
          </div>
        )}
      </div>

      {/* Fields List */}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : fields.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {fields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                busy={busyId === field.id}
                onRename={handleRename}
                onUpdateConfig={handleUpdateConfig}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single editable row with inline configuration for field types and dropdown options. */
function FieldRow({
  field,
  busy,
  onRename,
  onUpdateConfig,
  onDelete,
}: {
  field: CustomField;
  busy: boolean;
  onRename: (field: CustomField, name: string) => Promise<boolean>;
  onUpdateConfig: (
    field: CustomField,
    nextType: string,
    options: string[]
  ) => Promise<boolean>;
  onDelete: (field: CustomField) => void;
}) {
  const t = useTranslations('Contacts.customFields');
  const [name, setName] = useState(field.field_name);
  const [editingConfig, setEditingConfig] = useState(false);

  const initialType = (field.field_type as CustomFieldType) || 'text';
  const [rowType, setRowType] = useState<CustomFieldType>(initialType);
  const [rowOptions, setRowOptions] = useState(
    getFieldOptions(field).join(', ')
  );

  useEffect(() => {
    setName(field.field_name);
    setRowType((field.field_type as CustomFieldType) || 'text');
    setRowOptions(getFieldOptions(field).join(', '));
  }, [field]);

  async function commitName() {
    if (name.trim() === field.field_name) {
      setName(field.field_name);
      return;
    }
    const ok = await onRename(field, name);
    if (!ok) setName(field.field_name);
  }

  async function saveConfig() {
    const opts =
      rowType === 'dropdown'
        ? rowOptions
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const ok = await onUpdateConfig(field, rowType, opts);
    if (ok) {
      setEditingConfig(false);
    }
  }

  const currentType = getFieldType(field);
  const currentOptions = getFieldOptions(field);

  return (
    <li className="px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-label={t('renameAria', { name: field.field_name })}
          className="focus:border-primary h-8 border-transparent bg-transparent text-foreground hover:border-border flex-1 font-medium text-sm"
        />

        <Badge
          variant="outline"
          className="text-[10px] uppercase font-mono px-1.5 py-0.5 text-muted-foreground border-border/80 shrink-0"
        >
          {currentType === 'dropdown'
            ? `Dropdown (${currentOptions.length})`
            : currentType}
        </Badge>

        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => setEditingConfig((prev) => !prev)}
          title={t('editField')}
          className={`shrink-0 ${
            editingConfig ? 'text-primary bg-muted' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Settings2 className="size-3.5" />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          onClick={() => onDelete(field)}
          title={t('deleteTitle')}
          className="shrink-0 text-muted-foreground hover:text-red-400"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </div>

      {editingConfig && (
        <div className="rounded-md border border-border bg-muted/40 p-2.5 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <Label className="text-muted-foreground text-[11px] shrink-0">
              {t('typeLabel')}:
            </Label>
            <Select
              value={rowType}
              onValueChange={(v) => v && setRowType(v as CustomFieldType)}
            >
              <SelectTrigger className="h-7 text-xs bg-muted border-border text-foreground w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-popover border-border text-popover-foreground">
                <SelectItem value="text">{t('typeText')}</SelectItem>
                <SelectItem value="dropdown">{t('typeDropdown')}</SelectItem>
                <SelectItem value="number">{t('typeNumber')}</SelectItem>
                <SelectItem value="email">{t('typeEmail')}</SelectItem>
                <SelectItem value="phone">{t('typePhone')}</SelectItem>
                <SelectItem value="date">{t('typeDate')}</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-1 ml-auto">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditingConfig(false)}
                className="h-7 text-xs text-muted-foreground"
              >
                <X className="size-3" />
              </Button>
              <Button
                size="sm"
                onClick={saveConfig}
                disabled={busy}
                className="h-7 text-xs bg-primary hover:bg-primary/90 text-primary-foreground gap-1"
              >
                <Check className="size-3" />
                {t('saveField')}
              </Button>
            </div>
          </div>

          {rowType === 'dropdown' && (
            <div className="space-y-1">
              <Label className="text-muted-foreground text-[11px]">
                {t('optionsLabel')}:
              </Label>
              <Input
                value={rowOptions}
                onChange={(e) => setRowOptions(e.target.value)}
                placeholder={t('optionsPlaceholder')}
                className="bg-muted text-foreground h-7 text-xs"
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

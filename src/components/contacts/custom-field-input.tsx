'use client';

import * as React from 'react';
import type { CustomField } from '@/types';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface CustomFieldInputProps {
  field: CustomField;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
}

/**
 * Extracts configured options for dropdown / select fields from `field_options`.
 * Handles both string arrays and comma-separated strings safely.
 */
export function getFieldOptions(field: CustomField): string[] {
  if (!field.field_options) return [];
  const raw = field.field_options.options;
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Normalizes field type into one of: 'text' | 'number' | 'email' | 'phone' | 'date' | 'dropdown'.
 */
export function getFieldType(field: CustomField): string {
  const type = (field.field_type || '').toLowerCase().trim();
  if (type === 'select' || type === 'dropdown') return 'dropdown';
  if (type === 'number') return 'number';
  if (type === 'email') return 'email';
  if (type === 'phone' || type === 'tel') return 'phone';
  if (type === 'date') return 'date';
  // If options are configured even if type is 'text', treat as dropdown
  const options = getFieldOptions(field);
  if (options.length > 0) return 'dropdown';
  return 'text';
}

export function CustomFieldInput({
  field,
  value,
  onChange,
  disabled = false,
  id,
  className,
  placeholder,
}: CustomFieldInputProps) {
  const fieldType = getFieldType(field);
  const options = getFieldOptions(field);
  const defaultPlaceholder = placeholder || `Enter ${field.field_name}...`;

  if (fieldType === 'dropdown' && options.length > 0) {
    const isCustomValue = value && !options.includes(value);

    return (
      <Select
        value={value || ''}
        onValueChange={(val) => {
          if (val === '__clear__') {
            onChange('');
          } else {
            onChange(val || '');
          }
        }}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          className={cn(
            'w-full bg-muted border-border text-foreground data-placeholder:text-muted-foreground',
            className
          )}
        >
          <SelectValue placeholder={`Select ${field.field_name}...`}>
            {value || <span className="text-muted-foreground">Select {field.field_name}...</span>}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="bg-popover border-border text-popover-foreground">
          {value && (
            <SelectItem value="__clear__" className="text-muted-foreground italic text-xs">
              — Clear selection —
            </SelectItem>
          )}
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
          {isCustomValue && (
            <SelectItem value={value}>
              {value} (current)
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    );
  }

  if (fieldType === 'number') {
    return (
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={defaultPlaceholder}
        className={cn(
          'bg-muted border-border text-foreground placeholder:text-muted-foreground',
          className
        )}
      />
    );
  }

  if (fieldType === 'email') {
    return (
      <Input
        id={id}
        type="email"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={defaultPlaceholder}
        className={cn(
          'bg-muted border-border text-foreground placeholder:text-muted-foreground',
          className
        )}
      />
    );
  }

  if (fieldType === 'phone') {
    return (
      <Input
        id={id}
        type="tel"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={defaultPlaceholder}
        className={cn(
          'bg-muted border-border text-foreground placeholder:text-muted-foreground',
          className
        )}
      />
    );
  }

  if (fieldType === 'date') {
    return (
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          'bg-muted border-border text-foreground placeholder:text-muted-foreground',
          className
        )}
      />
    );
  }

  // Default to text
  return (
    <Input
      id={id}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={defaultPlaceholder}
      className={cn(
        'bg-muted border-border text-foreground placeholder:text-muted-foreground',
        className
      )}
    />
  );
}

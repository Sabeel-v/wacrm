import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CustomFieldInput,
  getFieldOptions,
  getFieldType,
} from './custom-field-input';
import type { CustomField } from '@/types';

describe('CustomFieldInput helpers', () => {
  const baseField: CustomField = {
    id: 'f-1',
    user_id: 'u-1',
    account_id: 'acc-1',
    field_name: 'Class',
    field_type: 'text',
    created_at: new Date().toISOString(),
  };

  it('correctly extracts options from field_options array', () => {
    const field: CustomField = {
      ...baseField,
      field_options: { options: ['Plus One', 'Plus Two', '10th'] },
    };
    expect(getFieldOptions(field)).toEqual(['Plus One', 'Plus Two', '10th']);
  });

  it('correctly extracts options from comma-separated string', () => {
    const field: CustomField = {
      ...baseField,
      field_options: { options: 'Plus One, Plus Two, 10th' as unknown as string[] },
    };
    expect(getFieldOptions(field)).toEqual(['Plus One', 'Plus Two', '10th']);
  });

  it('returns empty array when field_options is missing or empty', () => {
    expect(getFieldOptions(baseField)).toEqual([]);
    expect(getFieldOptions({ ...baseField, field_options: null })).toEqual([]);
    expect(getFieldOptions({ ...baseField, field_options: { options: [] } })).toEqual([]);
  });

  it('identifies normalized field types', () => {
    expect(getFieldType({ ...baseField, field_type: 'text' })).toBe('text');
    expect(getFieldType({ ...baseField, field_type: 'number' })).toBe('number');
    expect(getFieldType({ ...baseField, field_type: 'email' })).toBe('email');
    expect(getFieldType({ ...baseField, field_type: 'phone' })).toBe('phone');
    expect(getFieldType({ ...baseField, field_type: 'tel' })).toBe('phone');
    expect(getFieldType({ ...baseField, field_type: 'date' })).toBe('date');
    expect(getFieldType({ ...baseField, field_type: 'dropdown' })).toBe('dropdown');
    expect(getFieldType({ ...baseField, field_type: 'select' })).toBe('dropdown');

    // If options are present on a text field, treats it as dropdown
    expect(
      getFieldType({
        ...baseField,
        field_type: 'text',
        field_options: { options: ['Plus One', 'Plus Two'] },
      })
    ).toBe('dropdown');
  });
});

describe('CustomFieldInput rendering', () => {
  const baseField: CustomField = {
    id: 'f-class',
    user_id: 'u-1',
    account_id: 'acc-1',
    field_name: 'Class',
    field_type: 'text',
    created_at: new Date().toISOString(),
  };

  it('renders a text input for text custom fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomFieldInput, {
        field: baseField,
        value: 'Plus Two',
        onChange: () => {},
      })
    );
    expect(html).toContain('type="text"');
    expect(html).toContain('value="Plus Two"');
    expect(html).toContain('Enter Class...');
  });

  it('renders a number input for number custom fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomFieldInput, {
        field: { ...baseField, field_name: 'Roll Number', field_type: 'number' },
        value: '42',
        onChange: () => {},
      })
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('value="42"');
  });

  it('renders an email input for email custom fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomFieldInput, {
        field: { ...baseField, field_name: 'Parent Email', field_type: 'email' },
        value: 'parent@example.com',
        onChange: () => {},
      })
    );
    expect(html).toContain('type="email"');
    expect(html).toContain('value="parent@example.com"');
  });

  it('renders a phone input for phone custom fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomFieldInput, {
        field: { ...baseField, field_name: 'Parent Phone', field_type: 'phone' },
        value: '+1234567890',
        onChange: () => {},
      })
    );
    expect(html).toContain('type="tel"');
    expect(html).toContain('value="+1234567890"');
  });

  it('renders a date input for date custom fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomFieldInput, {
        field: { ...baseField, field_name: 'Admission Date', field_type: 'date' },
        value: '2026-09-01',
        onChange: () => {},
      })
    );
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-09-01"');
  });

  it('renders dropdown options for dropdown custom fields with options', () => {
    const html = renderToStaticMarkup(
      React.createElement(CustomFieldInput, {
        field: {
          ...baseField,
          field_name: 'Class',
          field_type: 'dropdown',
          field_options: { options: ['Plus One', 'Plus Two', '10th'] },
        },
        value: 'Plus Two',
        onChange: () => {},
      })
    );
    // Base UI Select trigger renders value
    expect(html).toContain('Plus Two');
  });
});

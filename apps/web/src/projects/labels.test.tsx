import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n';
import {
  RecordStateBadge,
  StatusBadge,
  TypeIcon,
  enumLabel,
  recordStateLabel,
  statusLabel,
  statusTone,
  typeLabel,
} from './labels';

describe('project labels (web.md §5)', () => {
  it('translates enumerated values from the generated enum dictionary', () => {
    expect(typeLabel('mosque')).toBe(t('enum.project_type.mosque'));
    expect(statusLabel('maintenance')).toBe(t('enum.project_status.maintenance'));
    expect(recordStateLabel('returned')).toBe(t('enum.record_state.returned'));
    expect(enumLabel('staff_role', 'imam')).toBe(t('enum.staff_role.imam'));
  });

  it('never shows a raw key: unknown codes are shown as they are, empty as empty', () => {
    expect(typeLabel('unknown_code')).toBe('unknown_code');
    expect(statusLabel(null)).toBe('');
  });

  it('StatusBadge uses the contract status colours', () => {
    const { container } = render(<StatusBadge status="building" testId="sb" />);
    const badge = container.querySelector('[data-testid="sb"]')!;
    expect(badge.className).toContain('badge--building');
    expect(badge.textContent).toBe(statusLabel('building'));
    expect(statusTone('weird')).toBe('neutral');
  });

  it('RecordStateBadge and TypeIcon render', () => {
    const { container } = render(
      <div>
        <RecordStateBadge state="approved" />
        <TypeIcon type="combined" labelled />
        <TypeIcon type="school" />
      </div>,
    );
    expect(container.textContent).toContain(recordStateLabel('approved'));
    const icons = container.querySelectorAll('svg');
    expect(icons[0]!.getAttribute('aria-label')).toBe(typeLabel('combined'));
    expect(icons[1]!.getAttribute('aria-hidden')).toBe('true');
  });
});

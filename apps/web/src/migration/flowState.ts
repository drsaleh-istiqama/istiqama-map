/**
 * State of the migration dialog (see controller.ts). Kept apart from the controller so that
 * the first-run prompt can follow the flow without loading the runner.
 */
import { signal } from '@preact/signals';
import type { Prepared, RunProgress, RunReport } from './runner';
import type { V2Data } from './v2types';

export type MigrationInput = { kind: 'local' } | { kind: 'file'; data: V2Data };

export type FlowState =
  | { step: 'closed' }
  | { step: 'preparing'; input: MigrationInput }
  | { step: 'summary'; input: MigrationInput; prepared: Prepared }
  | { step: 'running'; input: MigrationInput; prepared: Prepared; progress: RunProgress }
  | { step: 'report'; report: RunReport }
  | { step: 'error'; input: MigrationInput; code: string };

export const flow = signal<FlowState>({ step: 'closed' });
/** The dialog is hidden while the run continues (the prompt offers to show it again). */
export const flowHidden = signal(false);

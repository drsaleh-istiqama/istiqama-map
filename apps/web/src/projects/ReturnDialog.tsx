import { useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { Button, confirm, Field, Modal } from '../ui';
import { useBackCloses } from './useBackCloses';

export interface ReturnDialogProps {
  open: boolean;
  projectName: string;
  onCancel: () => void;
  /** Resolves when the record was returned; a rejection keeps the dialog (and the note) open. */
  onSubmit: (note: string) => Promise<void>;
}

/**
 * "Return to the collector" with a required note. Esc, the close button, "cancel" and the
 * phone's Back button never throw a typed note away: they ask first (brief §7.4).
 */
export function ReturnDialog({ open, projectName, onCancel, onSubmit }: ReturnDialogProps) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const asking = useRef(false);

  const close = (): void => {
    setNote('');
    setError(null);
    onCancel();
  };

  /** True when nothing typed would be lost, or the user agreed to discard the note. */
  const mayDiscard = async (): Promise<boolean> => {
    if (busy) return false;
    if (note.trim() === '') return true;
    if (asking.current) return false;
    asking.current = true;
    try {
      return await confirm({
        title: t('projects.discardNoteTitle'),
        message: t('projects.discardNoteBody'),
        confirmLabel: t('projects.discardNote'),
        danger: true,
      });
    } finally {
      asking.current = false;
    }
  };

  /** Close request of the cancel button and of Back: closes only after `mayDiscard`. */
  const requestClose = async (): Promise<boolean> => {
    if (!(await mayDiscard())) return false;
    close();
    return true;
  };

  useBackCloses(open, requestClose);

  const submit = async (event?: Event): Promise<void> => {
    event?.preventDefault();
    if (!note.trim()) {
      setError(t('projects.returnNoteRequired'));
      return;
    }
    setBusy(true);
    try {
      await onSubmit(note.trim());
      setNote('');
      setError(null);
    } catch {
      setError(t('projects.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('projects.returnTitle')}
      onClose={close}
      testId="return-dialog"
      confirmClose={mayDiscard}
      footer={
        <>
          <Button testId="return-cancel" onClick={() => void requestClose()}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            testId="return-confirm"
            busy={busy}
            onClick={() => void submit()}
          >
            {t('projects.returnConfirm')}
          </Button>
        </>
      }
    >
      <form class="pdialog" noValidate onSubmit={(e) => void submit(e)}>
        <p>{t('projects.returnIntro', { name: projectName })}</p>
        <Field label={t('projects.returnNote')} htmlFor="return-note" required error={error}>
          <textarea
            data-testid="return-note"
            data-autofocus
            rows={4}
            maxLength={2000}
            value={note}
            onInput={(e) => {
              setNote(e.currentTarget.value);
              if (error) setError(null);
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}

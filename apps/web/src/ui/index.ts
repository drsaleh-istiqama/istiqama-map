/**
 * Shared UI kit (docs/contracts/web.md §3.3). Feature modules import from here:
 *
 *   import { Button, Field, Modal, confirm, toast, VirtualList, useDebounced } from '../ui';
 *
 * Styles: `tokens.css`, `base.css` and `ui.css` are loaded once by `main.tsx`.
 */
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Chips, type ChipOption, type ChipsOther, type ChipsProps } from './Chips';
export { confirm, ConfirmDialog, type ConfirmOptions } from './ConfirmDialog';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Field, fieldIds, type FieldProps } from './Field';
export {
  focusableElements,
  useDebounced,
  useFocusTrap,
  useLiveQuery,
  useMediaQuery,
} from './hooks';
export * from './icons';
export { Link, type LinkProps } from './Link';
export { Modal, type ModalProps } from './Modal';
export { Select, type SelectOption, type SelectProps } from './Select';
export { Spinner, type SpinnerProps } from './Spinner';
export { SyncBadge } from './SyncBadge';
export { dismissToast, toast, Toast, type ToastKind } from './Toast';
export { VirtualList, type VirtualListProps } from './VirtualList';
export { isStagingServer, loadAppSettings, serverEnvironment } from './appSettings';
export { captureError } from './monitoring';
export { purgeUserCaches } from './pwa/register';

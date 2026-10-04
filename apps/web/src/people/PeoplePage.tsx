/**
 * People (route `/people`, brief §2.4): directory of the persons in the user's scope with a
 * local search, person card, edit, "add person" through the duplicate-aware picker, and for
 * reviewers the manual merge tool with its undoable trail. Viewers have no people data and
 * never reach this page (the nav item is hidden and the page refuses them as well).
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { can } from '../auth';
import { listPersons, type PersonCursor, type Row } from '../db';
import { fmt, pickName, t } from '../i18n';
import { navigate, useRoute } from '../routes';
import {
  Badge,
  Button,
  confirm,
  EmptyState,
  IconPlus,
  IconUsers,
  Modal,
  Spinner,
  useDebounced,
  useLiveQuery,
  VirtualList,
} from '../ui';
import { NameBlock, PhoneText, rolesText } from './display';
import { MergeDialog, type MergeMode } from './MergeDialog';
import { MergeRequestList } from './MergeRequests';
import { PersonCard } from './PersonCard';
import PersonPicker from './PersonPicker';
import { looksLikePhone, searchPersons, useDefaultDial } from './PersonSearch';
import { readAddPersonDraft, writeAddPersonDraft, type PersonPickerDraft } from './pickerDraft';
import {
  countPendingRequests,
  listMergeRequests,
  personQueryWords,
  searchPersonsPage,
  summarisePeople,
  type MergeRequest,
  type PersonSummary,
} from './queries';
import './people.css';

type Person = Row<'persons'>;

const PAGE = 50;
const ROW_HEIGHT = 76;

export default function PeoplePage() {
  if (!can.seePeople.value) {
    return (
      <div class="page people" data-testid="people-forbidden">
        <EmptyState
          icon={<IconUsers size={40} />}
          title={t('people.forbiddenTitle')}
          message={t('people.forbiddenBody')}
        />
      </div>
    );
  }
  return <PeopleView />;
}

interface MergeState {
  mode: MergeMode;
  sourceId?: string | null;
  request?: MergeRequest | null;
}

type Tab = 'directory' | 'requests';

function PeopleView() {
  const route = useRoute();
  const reviewer = can.review.value;
  const writer = can.write.value;
  const selected = route.query.get('id');
  const tab: Tab = reviewer && route.query.get('tab') === 'requests' ? 'requests' : 'directory';
  const [merge, setMerge] = useState<MergeState | null>(null);
  const [adding, setAdding] = useState(false);
  const addDirty = useRef(false);
  // The unfinished "add person" entry survives Back, a reload or a closed app (brief §7.4):
  // read when the dialog opens, written on every change, forgotten on create or discard.
  const [addDraft, setAddDraft] = useState<{ draft: PersonPickerDraft | null } | null>(null);
  useEffect(() => {
    if (!adding) {
      setAddDraft(null);
      return;
    }
    let alive = true;
    void readAddPersonDraft().then((draft) => alive && setAddDraft({ draft }));
    return () => {
      alive = false;
    };
  }, [adding]);
  const closeAdd = (): void => {
    addDirty.current = false;
    setAdding(false);
  };
  const pending = useLiveQuery(() => (reviewer ? countPendingRequests() : 0), [reviewer], 0);

  const openPerson = (id: string): void => navigate(`/people?id=${encodeURIComponent(id)}`);
  const setTab = (next: Tab): void =>
    navigate(next === 'requests' ? '/people?tab=requests' : '/people', { replace: true });

  return (
    <div class="page people" data-testid="people-page">
      {reviewer && <Tabs tab={tab} pending={pending ?? 0} onChange={setTab} />}

      {tab === 'directory' ? (
        <div
          id="people-panel-directory"
          role={reviewer ? 'tabpanel' : undefined}
          aria-labelledby={reviewer ? 'people-tab-directory' : undefined}
        >
          <Directory
            selected={selected}
            onSelect={openPerson}
            onAdd={writer ? () => setAdding(true) : undefined}
            card={
              selected ? (
                <PersonCard
                  key={selected}
                  personId={selected}
                  onBack={() => navigate('/people')}
                  onMerge={(mode, id) => setMerge({ mode, sourceId: id })}
                  onReview={(request) => setMerge({ mode: 'decide', request })}
                  onOpenPerson={openPerson}
                />
              ) : null
            }
          />
        </div>
      ) : (
        <div id="people-panel-requests" role="tabpanel" aria-labelledby="people-tab-requests">
          <Requests
            onReview={(request) => setMerge({ mode: 'decide', request })}
            onNewMerge={() => setMerge({ mode: 'merge' })}
            onOpenPerson={openPerson}
          />
        </div>
      )}

      <MergeDialog
        open={merge !== null}
        mode={merge?.mode ?? 'merge'}
        initialSourceId={merge?.sourceId ?? null}
        request={merge?.request ?? null}
        onClose={() => setMerge(null)}
        onDone={({ targetId }) => {
          setMerge(null);
          if (targetId) openPerson(targetId);
        }}
      />

      <Modal
        open={adding}
        title={t('people.addPersonTitle')}
        size="lg"
        testId="people-add-dialog"
        onClose={() => {
          // A deliberate close (confirmed when something was typed) forgets the entry; Back
          // or a reload unmount the dialog without closing it, so the draft stays.
          void writeAddPersonDraft(null);
          closeAdd();
        }}
        confirmClose={async () =>
          !addDirty.current ||
          confirm({
            title: t('people.discardTitle'),
            message: t('people.discardMessage'),
            confirmLabel: t('people.discardConfirm'),
            danger: true,
          })
        }
      >
        <p class="merge__intro">{t('people.addPersonHint')}</p>
        {addDraft === null ? (
          <Spinner />
        ) : (
          <>
            {addDraft.draft && (
              <p class="pp-note" role="status" data-testid="people-add-restored">
                {t('people.draftRestored')}
              </p>
            )}
            <PersonPicker
              value={null}
              persist
              autoFocus
              testId="people-add-picker"
              label={t('people.pickerLabel')}
              draft={addDraft.draft}
              onDraftChange={(draft) => void writeAddPersonDraft(draft)}
              onDirtyChange={(dirty) => {
                addDirty.current = dirty;
              }}
              onChange={(sel) => {
                void writeAddPersonDraft(null);
                closeAdd();
                if ('personId' in sel) openPerson(sel.personId);
              }}
            />
          </>
        )}
      </Modal>
    </div>
  );
}

function Tabs({
  tab,
  pending,
  onChange,
}: {
  tab: Tab;
  pending: number;
  onChange: (next: Tab) => void;
}) {
  const order: readonly Tab[] = ['directory', 'requests'];
  const onKeyDown = (event: KeyboardEvent): void => {
    const i = order.indexOf(tab);
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = (i + 1) % order.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = order.length - 1;
    if (next === null) return;
    event.preventDefault();
    const id = order[next]!;
    onChange(id);
    queueMicrotask(() => document.getElementById(`people-tab-${id}`)?.focus());
  };
  return (
    <div
      class="people__tabs"
      role="tablist"
      aria-label={t('people.tabsLabel')}
      onKeyDown={onKeyDown}
    >
      {order.map((id) => (
        <button
          key={id}
          id={`people-tab-${id}`}
          type="button"
          role="tab"
          class="people__tab"
          aria-selected={tab === id ? 'true' : 'false'}
          aria-controls={`people-panel-${id}`}
          tabIndex={tab === id ? 0 : -1}
          data-testid={`people-tab-${id}`}
          onClick={() => onChange(id)}
        >
          {id === 'directory' ? t('people.tabDirectory') : t('people.tabRequests')}
          {id === 'requests' && pending > 0 && (
            <Badge tone="warning" title={t('people.pendingBadge', { count: pending })}>
              {fmt.number(pending)}
            </Badge>
          )}
        </button>
      ))}
    </div>
  );
}

/** What the directory shows: the first `pages` keyset pages of one query. */
interface View {
  /** Query and calling code the view was read for (a newer query makes it stale). */
  key: string;
  pages: number;
  rows: Person[];
  summaries: Map<string, PersonSummary>;
  /** Cursor after the last row shown; null when everything is shown. */
  next: PersonCursor | null;
  /** Matches of a name search on this device (null: unfiltered list or phone lookup). */
  total: number | null;
}

/** How the directory is read: every person, a name search, or one phone number. */
type Source = { kind: 'all' } | { kind: 'name'; q: string } | { kind: 'phone' };

const live = (rows: readonly Person[]): Person[] =>
  rows.filter((p) => !p.deleted_at && !p.merged_into_id);

function sourceOf(q: string): Source {
  if (!q) return { kind: 'all' };
  if (looksLikePhone(q)) return { kind: 'phone' };
  // A query without a searchable word (one character) does not filter yet.
  return personQueryWords(q).length > 0 ? { kind: 'name', q } : { kind: 'all' };
}

/**
 * The first `pages` keyset pages of the directory (brief §5: pages of 50 ordered by name,
 * searched lists included; a phone lookup is one page). Read inside a live query, so an
 * edit, a pull or a merge refreshes what is shown without dropping the pages already loaded.
 */
async function readView(
  key: string,
  source: Source,
  q: string,
  dial: string | null,
  pages: number,
): Promise<View> {
  let rows: Person[] = [];
  let next: PersonCursor | null = null;
  let total: number | null = null;
  if (source.kind === 'phone') {
    rows = await searchPersons(q, PAGE, dial);
  } else {
    const found = source.kind === 'name' ? await searchPersonsPage(q, null, pages * PAGE) : null;
    if (found) {
      ({ rows, next, total } = found);
    } else {
      for (let i = 0; i < pages; i++) {
        const page = await listPersons(undefined, next, PAGE);
        rows = rows.concat(page.rows);
        next = page.next;
        if (!next) break;
      }
    }
  }
  rows = live(rows);
  return { key, pages, rows, next, total, summaries: await summarisePeople(rows) };
}

function Directory({
  selected,
  onSelect,
  onAdd,
  card,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd?: () => void;
  card: ComponentChildren;
}) {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const dial = useDefaultDial();
  const source = sourceOf(q);
  const listKey = `${q}\n${dial ?? ''}`;
  // Pages to show for the current query: one more each time the list nears its end; back to
  // one when the query changes.
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  // Live: what is shown is read again whenever its rows change (edit, pull, merge).
  const view = useLiveQuery(() => readView(listKey, source, q, dial, pages), [listKey, pages]);
  const current = view?.key === listKey && view.pages === pages;

  const state = {
    rows: view?.rows ?? [],
    summaries: view?.summaries ?? new Map<string, PersonSummary>(),
    next: view?.next ?? null,
    total: view?.key === listKey ? view.total : null,
    loading: !current,
  };

  // Asked only when the shown view is current: the list asks once per length, and a request
  // made while an older view is on screen must not be lost.
  const loadMore =
    current && state.next ? () => setPaging({ key: listKey, pages: pages + 1 }) : undefined;

  const empty = !state.loading && state.rows.length === 0;

  return (
    <div class={selected ? 'people__layout people__layout--split' : 'people__layout'}>
      <div class="people__listpane people">
        <div class="people__toolbar">
          <div class="field people__search">
            <label class="field__label" for="people-search">
              {t('people.searchLabel')}
            </label>
            <input
              id="people-search"
              class="control"
              type="search"
              autocomplete="off"
              data-testid="search-input"
              placeholder={t('people.searchPlaceholder')}
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          {onAdd && (
            <Button
              variant="gold"
              icon={<IconPlus size={20} />}
              testId="people-add"
              onClick={onAdd}
            >
              {t('people.addPerson')}
            </Button>
          )}
        </div>
        <p
          class="people__count"
          role="status"
          aria-live="polite"
          data-testid="people-count"
          data-shown={state.rows.length}
          data-total={state.total ?? undefined}
        >
          {state.loading && state.rows.length === 0
            ? t('ui.loading')
            : state.total !== null && state.total > state.rows.length
              ? t('people.resultsCountOf', {
                  count: fmt.number(state.rows.length),
                  total: fmt.number(state.total),
                })
              : t('people.resultsCount', { count: fmt.number(state.rows.length) })}
        </p>
        {empty ? (
          <EmptyState
            icon={<IconUsers size={40} />}
            title={q ? t('people.noResultsTitle') : t('people.emptyTitle')}
            message={q ? t('people.noResultsBody') : t('people.emptyBody')}
            testId="people-empty"
          />
        ) : state.rows.length === 0 ? (
          <Spinner />
        ) : (
          <div class="people__list">
            <VirtualList
              // A new query starts a fresh list (top, and "end reached" counted anew).
              key={listKey}
              items={state.rows}
              rowHeight={ROW_HEIGHT}
              rowKey={(p) => p.id}
              label={t('people.listLabel')}
              testId="people-list"
              onEndReached={loadMore}
              onActivate={(i) => {
                const p = state.rows[i];
                if (p) onSelect(p.id);
              }}
              renderRow={(p) => (
                <PersonRow
                  person={p}
                  summary={state.summaries.get(p.id)}
                  selected={p.id === selected}
                />
              )}
            />
          </div>
        )}
      </div>
      {selected ? <div class="people__cardpane">{card}</div> : null}
    </div>
  );
}

function PersonRow({
  person,
  summary,
  selected,
}: {
  person: Person;
  summary: PersonSummary | undefined;
  selected: boolean;
}) {
  const meta = [
    summary && summary.roles.length > 0 ? rolesText(summary.roles) : t('people.rolesNone'),
    summary?.home ? pickName(summary.home) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      class={selected ? 'person-row person-row--selected' : 'person-row'}
      data-testid="person-row"
      data-person-id={person.id}
      aria-current={selected ? 'true' : undefined}
    >
      <div class="person-row__main">
        <NameBlock person={person} />
        <span class="person-row__meta">{meta}</span>
      </div>
      <div class="person-row__side">
        <PhoneText phone={person.phone_e164} />
        {summary && summary.projects > 0 && (
          <span class="muted">{t('people.projectsCount', { count: summary.projects })}</span>
        )}
      </div>
    </div>
  );
}

function Requests({
  onReview,
  onNewMerge,
  onOpenPerson,
}: {
  onReview: (r: MergeRequest) => void;
  onNewMerge: () => void;
  onOpenPerson: (id: string) => void;
}) {
  const requests = useLiveQuery(() => listMergeRequests(), [], undefined);
  return (
    <section class="people" aria-labelledby="people-requests-title">
      <div class="people__toolbar people__toolbar--spread">
        <h2 id="people-requests-title" class="people__requests-title">
          {t('people.requestsTitle')}
        </h2>
        <Button variant="primary" testId="merge-new" onClick={onNewMerge}>
          {t('people.mergeTitle')}
        </Button>
      </div>
      {requests === undefined ? (
        <Spinner />
      ) : (
        <MergeRequestList
          requests={requests}
          canReview
          onReview={onReview}
          onOpenPerson={onOpenPerson}
        />
      )}
    </section>
  );
}

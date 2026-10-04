import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualList } from './VirtualList';

afterEach(cleanup);

const ROW = 50;
// happy-dom has no layout: the list falls back to a 600 px viewport → 12 visible rows.
const items = Array.from({ length: 100_000 }, (_, index) => ({
  id: `p${index}`,
  name: `Project ${index}`,
}));

function renderedIndexes(): number[] {
  return screen.getAllByRole('listitem').map((row) => Number(row.getAttribute('data-index')));
}

function scrollTo(list: HTMLElement, top: number): void {
  list.scrollTop = top;
  fireEvent.scroll(list);
}

describe('<VirtualList>', () => {
  it('renders a small window of 100,000 rows with the full scroll height', () => {
    const renderRow = vi.fn((item: { name: string }) => <span>{item.name}</span>);
    render(
      <VirtualList
        items={items}
        rowHeight={ROW}
        renderRow={renderRow}
        rowKey={(item) => item.id}
        testId="list"
        label="Projects"
      />,
    );

    const rows = renderedIndexes();
    expect(rows[0]).toBe(0);
    expect(rows.length).toBeLessThanOrEqual(12 + 1 + 4);
    expect(renderRow.mock.calls.length).toBeLessThan(40);
    expect(screen.getByRole('list').style.blockSize).toBe(`${100_000 * ROW}px`);
    expect(screen.getByRole('list').getAttribute('aria-label')).toBe('Projects');
    expect(screen.getByText('Project 0')).toBeTruthy();
    expect(screen.queryByText('Project 500')).toBeNull();
  });

  it('positions rows by index and exposes their place in the whole list', () => {
    render(
      <VirtualList items={items} rowHeight={ROW} renderRow={(item) => item.name} testId="list" />,
    );
    const third = screen.getAllByRole('listitem')[2] as HTMLElement;
    expect(third.style.transform).toBe(`translateY(${2 * ROW}px)`);
    expect(third.style.blockSize).toBe(`${ROW}px`);
    expect(third.getAttribute('aria-posinset')).toBe('3');
    expect(third.getAttribute('aria-setsize')).toBe('100000');
  });

  it('follows the scroll position', async () => {
    render(
      <VirtualList items={items} rowHeight={ROW} renderRow={(item) => item.name} testId="list" />,
    );
    scrollTo(screen.getByTestId('list'), 70_000 * ROW + 20);
    await waitFor(() => expect(screen.getByText('Project 70000')).toBeTruthy());
    const rows = renderedIndexes();
    expect(rows[0]).toBe(70_000 - 4);
    expect(rows.length).toBeLessThanOrEqual(12 + 1 + 8);
    expect(screen.queryByText('Project 0')).toBeNull();
  });

  it('supports the itemCount form', () => {
    render(<VirtualList itemCount={5} rowHeight={ROW} renderRow={(index) => `row ${index}`} />);
    expect(renderedIndexes()).toEqual([0, 1, 2, 3, 4]);
    expect(screen.getByText('row 4')).toBeTruthy();
  });

  it('calls onEndReached once per list length when the end comes into view', async () => {
    const onEndReached = vi.fn();
    const page = items.slice(0, 50);
    const view = render(
      <VirtualList
        items={page}
        rowHeight={ROW}
        renderRow={(item) => item.name}
        onEndReached={onEndReached}
        testId="list"
      />,
    );
    expect(onEndReached).not.toHaveBeenCalled();

    const list = screen.getByTestId('list');
    scrollTo(list, 50 * ROW - 600);
    await waitFor(() => expect(onEndReached).toHaveBeenCalledTimes(1));
    scrollTo(list, 50 * ROW - 650);
    scrollTo(list, 50 * ROW - 600);
    expect(onEndReached).toHaveBeenCalledTimes(1); // not again for the same 50 rows

    // The next keyset page arrives: the list grows and can ask again.
    view.rerender(
      <VirtualList
        items={items.slice(0, 100)}
        rowHeight={ROW}
        renderRow={(item) => item.name}
        onEndReached={onEndReached}
        testId="list"
      />,
    );
    scrollTo(list, 100 * ROW - 600);
    await waitFor(() => expect(onEndReached).toHaveBeenCalledTimes(2));
  });

  it('asks for more at once when the first page does not fill the viewport', async () => {
    const onEndReached = vi.fn();
    render(
      <VirtualList
        items={items.slice(0, 5)}
        rowHeight={ROW}
        renderRow={(item) => item.name}
        onEndReached={onEndReached}
      />,
    );
    await waitFor(() => expect(onEndReached).toHaveBeenCalledTimes(1));
  });

  it('has one tab stop and moves between rows with the keyboard', async () => {
    const onActivate = vi.fn();
    render(
      <VirtualList
        items={items}
        rowHeight={ROW}
        renderRow={(item) => item.name}
        onActivate={onActivate}
        testId="list"
      />,
    );
    const list = screen.getByTestId('list');
    const tabStops = (): HTMLElement[] =>
      screen.getAllByRole('listitem').filter((row) => row.getAttribute('tabindex') === '0');
    expect(tabStops()).toHaveLength(1);

    const first = tabStops()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-index')).toBe('1'));
    expect(tabStops()).toHaveLength(1);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-index')).toBe('99999'));
    expect(list.scrollTop).toBe(100_000 * ROW - 600);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledWith(99_999);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-index')).toBe('0'));
    expect(list.scrollTop).toBe(0);
  });

  it('activates a row on click', () => {
    const onActivate = vi.fn();
    render(
      <VirtualList
        items={items}
        rowHeight={ROW}
        renderRow={(item) => item.name}
        onActivate={onActivate}
      />,
    );
    fireEvent.click(screen.getByText('Project 3'));
    expect(onActivate).toHaveBeenCalledWith(3);
  });
});

import type { TableProps } from "antd";

/**
 * `sticky` config for a table inside a scrolling box: the header sticks to the box's top, and a table that scrolls
 * sideways (`scroll.x`) keeps its scroll bar at the bottom of that box (`getContainer`, the window by default).
 * `selector` finds the box when the table mounts.
 */
export function stickyIn(selector: string): NonNullable<TableProps["sticky"]> {
  return { offsetHeader: 0, getContainer: () => document.querySelector<HTMLElement>(selector) ?? window };
}

/** For tables on a workspace page: the page scrolls inside `.ws-page`, under the header. */
export const PAGE_TABLE_STICKY = stickyIn(".ws-page");

/** For tables that do not scroll sideways, in drawers, modals, panels: the nearest scrolling box holds the header. */
export const CONTAINER_TABLE_STICKY = { offsetHeader: 0 } as const;

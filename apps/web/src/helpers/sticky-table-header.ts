import type { RefObject } from "react";
import type { TableProps } from "antd";

/**
 * `sticky` config for a table inside a scrolling box: the header sticks to the box's top, and a table that scrolls
 * sideways (`scroll.x`) keeps its scroll bar at the bottom of that box (`getContainer`, the window by default).
 * `box`: a selector, or a ref to the box, read when the table mounts.
 */
export function stickyIn(box: string | RefObject<HTMLElement | null>): NonNullable<TableProps["sticky"]> {
  return { offsetHeader: 0, getContainer: () => (typeof box === "string" ? document.querySelector<HTMLElement>(box) : box.current) ?? window };
}

/** For tables on a workspace page: the page scrolls inside `.ws-page`, under the header. */
export const PAGE_TABLE_STICKY = stickyIn(".ws-page");

/**
 * `sticky` config for tables rendered directly on a page: keeps the header visible below the
 * fixed ProLayout header (56px) while the page scrolls.
 */
export const PAGE_TABLE_STICKY = { offsetHeader: 56 } as const;

/**
 * `sticky` config for tables inside drawers, modals and other scroll containers: the header
 * sticks to the top of the nearest scrolling ancestor.
 */
export const CONTAINER_TABLE_STICKY = { offsetHeader: 0 } as const;

/**
 * The filter sidebar of ag-go's web (`shared/components/filter-sidebar`), rebuilt for Studio's full-screen project
 * drawer: docked beside the list from `xl` (remembered in this browser), in a drawer below it; collapsible sections
 * with counts and "clear", a summary of the filters in use, searchable checkbox lists and a checkable folder tree.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type Key, type ReactNode, type SetStateAction } from "react";
import { Badge, Button, Checkbox, Collapse, Drawer, Empty, Flex, Grid, Input, Skeleton, Tag, Tooltip, Tree, Typography, theme } from "antd";
import type { DataNode } from "antd/es/tree";
import { ChevronDown, ChevronUp, Filter as FilterIcon, Search, X } from "lucide-react";
import { useAiTranslation } from "../../common/assistant-name";
import { compareText, formatNumber, highlightText, matchesAllWords, matchesWords, normalizeSearchText, searchWords } from "./text-match";

const SIDEBAR_WIDTH = 300;
/** Each "show more" reveals this many more rows, instead of a scroll box inside the sidebar. */
const SHOW_MORE_STEP = 20;
const INITIAL_FOLDER_ROOTS = 10;

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : saved === "true";
  } catch {
    return fallback;
  }
}

/** Where the filters show: beside the list from `xl` (remembered under `storageKey`), in a drawer below it. */
export function useFilterSidebar(storageKey: string) {
  const screens = Grid.useBreakpoint();
  const isWide = screens.xl !== false;
  const [open, setOpen] = useState(() => readStoredBoolean(storageKey, true));
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(storageKey, String(open)); } catch { /* this visit only */ }
  }, [open, storageKey]);
  return {
    docked: isWide && open,
    drawerOpen: !isWide && drawerOpen,
    show: () => (isWide ? setOpen(true) : setDrawerOpen(true)),
    hide: () => setOpen(false),
    closeDrawer: () => setDrawerOpen(false),
  };
}
export type FilterSidebarState = ReturnType<typeof useFilterSidebar>;

/** The look of the panels (filters, list): flat bordered cards on the page background. */
export function usePanelStyle(): CSSProperties {
  const { token } = theme.useToken();
  return { background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG };
}

/** Which sections are open: `defaultOpen` and those in use; a section that gets a value later opens then. */
export function useFilterSectionsOpen(defaultOpen: string[], activeKeys: string[]): [string[], Dispatch<SetStateAction<string[]>>] {
  const [openKeys, setOpenKeys] = useState<string[]>(() => [...new Set([...defaultOpen, ...activeKeys])]);
  const active = activeKeys.join();
  const previous = useRef(active);
  useEffect(() => {
    const before = new Set(previous.current.split(","));
    previous.current = active;
    const added = active.split(",").filter((k) => k && !before.has(k));
    if (added.length) setOpenKeys((current) => [...new Set([...current, ...added])]);
  }, [active]);
  return [openKeys, setOpenKeys];
}

/** Opens the filters when they are not beside the list; shows how many are in use. */
export function FilterToggleButton({ state, activeCount }: { state: FilterSidebarState; activeCount: number }) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  if (state.docked) return null;
  return (
    <Badge count={activeCount} size="small" color={token.colorPrimary}>
      <Button icon={<FilterIcon size={15} />} onClick={state.show}>{t("ws.agp.filters")}</Button>
    </Badge>
  );
}

/**
 * The drawer's body: the filter panel docked on the left (its header stays while its body scrolls) and the list in
 * its own panel, or the filters in a drawer on narrow screens.
 */
export function FilterSidebarLayout({ state, activeCount, onClear, sidebar, contentStyle, children }: {
  state: FilterSidebarState; activeCount: number; onClear: () => void; sidebar: ReactNode; contentStyle?: CSSProperties; children: ReactNode;
}) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  const panelStyle = usePanelStyle();
  const clear = activeCount > 0 ? <Button type="link" danger size="small" onClick={onClear}>{t("ws.agp.clearFilters")}</Button> : null;
  return (
    <>
      <Flex align="start" gap={16}>
        {state.docked ? (
          <aside
            aria-label={t("ws.agp.filters")}
            style={{
              width: SIDEBAR_WIDTH, flexShrink: 0, position: "sticky", top: 0, maxHeight: "calc(100dvh - var(--agp-drawer-head, 64px) - 32px)",
              display: "flex", flexDirection: "column", overflow: "hidden", ...panelStyle,
            }}
          >
            <Flex align="center" justify="space-between" style={{ flexShrink: 0, padding: "10px 12px", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
              <Typography.Text strong style={{ fontSize: 15 }}>{t("ws.agp.filters")}</Typography.Text>
              <Flex align="center" gap={4}>
                {clear}
                <Tooltip title={t("ws.agp.hideFilters")}>
                  <Button aria-label={t("ws.agp.hideFilters")} icon={<X size={16} />} size="small" type="text" onClick={state.hide} />
                </Tooltip>
              </Flex>
            </Flex>
            <div className="agp-thin-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px 8px" }}>{sidebar}</div>
          </aside>
        ) : null}
        <div style={{ flex: 1, minWidth: 0, ...contentStyle, ...panelStyle }}>{children}</div>
      </Flex>
      <Drawer
        open={state.drawerOpen} placement="left" width={Math.min(SIDEBAR_WIDTH + 48, window.innerWidth - 32)} title={t("ws.agp.filters")}
        extra={clear} onClose={state.closeDrawer} styles={{ body: { paddingInline: 16 } }}
      >
        {sidebar}
      </Drawer>
    </>
  );
}

export type FilterSectionItem = { key: string; icon: ReactNode; label: string; count: number; onClear: () => void; children: ReactNode };

/** Collapsible filter sections separated by rules, each with its count and "clear" button. */
export function FilterSections({ items, openKeys, onOpenKeysChange, borderFirst = true }: {
  items: FilterSectionItem[]; openKeys: string[]; onOpenKeysChange: Dispatch<SetStateAction<string[]>>; borderFirst?: boolean;
}) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  const keys = new Set(items.map((i) => i.key));
  const label = (item: FilterSectionItem) => (
    <Flex align="center" justify="space-between" gap={8}>
      <Flex align="center" gap={8}>
        <span style={{ display: "flex", color: token.colorTextTertiary }}>{item.icon}</span>
        <Typography.Text strong>{item.label}</Typography.Text>
        {item.count > 0 ? (
          <span style={{ minWidth: 18, paddingInline: 6, borderRadius: 9, background: token.colorPrimaryBg, color: token.colorPrimary, fontSize: 12, fontWeight: 600, lineHeight: "18px", textAlign: "center" }}>
            {item.count}
          </span>
        ) : null}
      </Flex>
      {item.count > 0 ? (
        <Button type="text" size="small" style={{ paddingInline: 4, height: 22, fontSize: 12, color: token.colorTextTertiary }}
          onClick={(e) => { e.stopPropagation(); item.onClear(); }}>
          {t("ws.agp.clearSelection")}
        </Button>
      ) : null}
    </Flex>
  );
  return (
    <Collapse
      ghost size="small" expandIconPosition="end"
      items={items.map((item, index) => ({
        key: item.key, label: label(item), children: item.children,
        style: { borderTop: index > 0 || borderFirst ? `1px solid ${token.colorBorderSecondary}` : undefined, borderRadius: 0 },
        styles: { header: { padding: "16px 4px", alignItems: "center" }, body: { padding: "0 4px 20px" } },
      }))}
      activeKey={openKeys.filter((k) => keys.has(k))}
      onChange={(next) => {
        const opened = Array.isArray(next) ? next : [next];
        onOpenKeysChange((current) => [...current.filter((k) => !keys.has(k)), ...opened]);
      }}
    />
  );
}

export type ActiveFilterChip = { key: string; label: string; onRemove: () => void };

/** "N filters applied" with each value as a removable tag; hidden when nothing is picked. */
export function ActiveFilterSummary({ count, chips }: { count: number; chips: ActiveFilterChip[] }) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  if (count === 0) return null;
  return (
    <Flex vertical gap={8} style={{ margin: "8px 0 12px", padding: 10, borderRadius: token.borderRadius, background: token.colorFillQuaternary }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>{t("ws.agp.activeFiltersCount", { count })}</Typography.Text>
      {chips.length ? (
        <Flex wrap gap={6} align="center">
          {chips.map((chip) => (
            <Tag
              key={chip.key} closable bordered={false} title={chip.label}
              style={{ display: "inline-flex", alignItems: "center", marginInlineEnd: 0, maxWidth: "100%", background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}` }}
              onClose={(e) => { e.preventDefault(); chip.onRemove(); }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{chip.label}</span>
            </Tag>
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
}

/** Toggle for the sections kept behind "more filters". */
export function MoreFiltersToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  return (
    <Button type="text" size="small" icon={open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      style={{ marginTop: 4, alignSelf: "flex-start", paddingInline: 4, color: token.colorTextSecondary }} onClick={onToggle}>
      {open ? t("ws.agp.lessFilters") : t("ws.agp.moreFilters")}
    </Button>
  );
}

function ShowMoreLess({ hiddenCount, canCollapse, onMore, onLess }: { hiddenCount: number; canCollapse: boolean; onMore: () => void; onLess: () => void }) {
  const { t, i18n } = useAiTranslation();
  const { token } = theme.useToken();
  if (hiddenCount <= 0 && !canCollapse) return null;
  const style = { paddingInline: 4, color: token.colorTextSecondary };
  return (
    <Flex gap={4}>
      {hiddenCount > 0 ? <Button type="text" size="small" icon={<ChevronDown size={14} />} style={style} onClick={onMore}>{t("ws.agp.showMoreCount", { count: formatNumber(hiddenCount, i18n.language) })}</Button> : null}
      {canCollapse ? <Button type="text" size="small" icon={<ChevronUp size={14} />} style={style} onClick={onLess}>{t("ws.agp.showLess")}</Button> : null}
    </Flex>
  );
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { token } = theme.useToken();
  return (
    <Input allowClear variant="filled" placeholder={placeholder} aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)}
      prefix={<Search size={14} style={{ color: token.colorTextQuaternary }} />} />
  );
}

/** An option's name, cut with "…" when long, and its count at the right. */
function OptionLabel({ name, count, search }: { name: string; count?: number | undefined; search: string }) {
  const { i18n } = useAiTranslation();
  return (
    <span className="agp-filter-option">
      <span className="agp-filter-option-name" title={name}>{highlightText(name, search)}</span>
      {count !== undefined ? <span className="agp-filter-option-count">{formatNumber(count, i18n.language)}</span> : null}
    </span>
  );
}

const SKELETON_WIDTHS = ["72%", "55%", "84%", "48%", "66%"];

/** Rows shaped like the options (a checkbox and a name) while they load. */
function OptionListSkeleton({ indent = 0, rowHeight = 22, rowGap = 8 }: { indent?: number; rowHeight?: number; rowGap?: number }) {
  return (
    <Flex vertical gap={rowGap} style={{ paddingInlineStart: indent }}>
      {SKELETON_WIDTHS.map((width, i) => (
        <Flex key={i} align="center" gap={8} style={{ height: rowHeight }}>
          <Skeleton.Avatar active shape="square" size={16} style={{ borderRadius: 4 }} />
          <div style={{ width }}><Skeleton.Input active block size="small" style={{ minWidth: 0, height: 14 }} /></div>
        </Flex>
      ))}
    </Flex>
  );
}

export type CheckboxListOption = { value: string; label: string; searchText: string; count?: number };

/** Searchable checkbox list, alphabetical, the first few with "show more"; ticked ones always show. */
export function CheckboxListFilter({ options, loading, value, onChange, searchPlaceholder, emptyText, notFoundText, initialVisible = 8 }: {
  options: CheckboxListOption[]; loading: boolean; value?: string[] | undefined; onChange: (ids: string[] | undefined) => void;
  searchPlaceholder: string; emptyText: string; notFoundText: string; initialVisible?: number;
}) {
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [limit, setLimit] = useState(initialVisible);
  const prepared = useMemo(() => options.map((o) => ({ ...o, normalized: normalizeSearchText(o.searchText) })).sort((a, b) => compareText(a.searchText, b.searchText)), [options]);
  const matching = useMemo(() => {
    const words = searchWords(deferred);
    return words.length ? prepared.filter((o) => matchesWords(words, o.normalized)) : prepared;
  }, [prepared, deferred]);
  const selected = useMemo(() => new Set(value ?? []), [value]);
  const visible = matching.filter((o, i) => i < limit || (!deferred.trim() && selected.has(o.value)));
  useEffect(() => setLimit(initialVisible), [search, initialVisible]);
  return (
    <Flex vertical gap={8}>
      {options.length > initialVisible ? <SearchInput value={search} onChange={setSearch} placeholder={searchPlaceholder} /> : null}
      {loading ? <OptionListSkeleton /> : visible.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>{deferred.trim() ? notFoundText : emptyText}</Typography.Text>
      ) : (
        <Checkbox.Group
          value={value ?? []}
          onChange={(checked) => {
            const shown = new Set(visible.map((o) => o.value));
            const next = [...(value ?? []).filter((id) => !shown.has(id)), ...(checked as string[])];
            onChange(next.length ? next : undefined);
          }}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          {visible.map((o) => <Checkbox key={o.value} value={o.value}><OptionLabel name={o.label} count={o.count} search={deferred} /></Checkbox>)}
        </Checkbox.Group>
      )}
      <ShowMoreLess hiddenCount={matching.length - visible.length} canCollapse={limit > initialVisible}
        onMore={() => setLimit((c) => c + SHOW_MORE_STEP)} onLess={() => setLimit(initialVisible)} />
    </Flex>
  );
}

export type FilterFolder = { id: string; name: string; parentId: string | null };

function buildFolderTree(folders: FilterFolder[], search: string): { treeData: DataNode[]; matching: Set<string> } {
  const query = search.trim();
  const matching = new Set<string>();
  if (query) {
    const byId = new Map(folders.map((f) => [f.id, f]));
    for (const f of folders) {
      if (!matchesAllWords(query, f.name)) continue;
      matching.add(f.id);
      let parent = f.parentId;
      while (parent) { matching.add(parent); parent = byId.get(parent)?.parentId ?? null; }
    }
  }
  const shown = query ? folders.filter((f) => matching.has(f.id)) : folders;
  const nodes = new Map<string, DataNode>(shown.map((f) => [f.id, { key: f.id, title: <OptionLabel name={f.name} search={search} />, children: [] }]));
  const roots: DataNode[] = [];
  for (const f of [...shown].sort((a, b) => compareText(a.name, b.name))) {
    const node = nodes.get(f.id)!;
    if (f.parentId && nodes.has(f.parentId)) (nodes.get(f.parentId)!.children as DataNode[]).push(node);
    else roots.push(node);
  }
  const clean = (list: DataNode[]): DataNode[] => list.map((n) => ({ ...n, children: n.children?.length ? clean(n.children) : undefined }) as DataNode);
  return { treeData: clean(roots), matching };
}

/** Folders whose ancestor is also ticked are dropped: ag-go already includes sub-folders. */
function withoutTickedDescendants(ids: string[], folders: FilterFolder[]): string[] {
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  const ticked = new Set(ids);
  return [...ticked].filter((id) => {
    let parent = parentOf.get(id);
    while (parent) { if (ticked.has(parent)) return false; parent = parentOf.get(parent); }
    return true;
  });
}

function ancestorIds(ids: string[], folders: FilterFolder[]): string[] {
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  const out = new Set<string>();
  for (const id of ids) {
    let parent = parentOf.get(id);
    while (parent && !out.has(parent)) { out.add(parent); parent = parentOf.get(parent); }
  }
  return [...out];
}

/** Checkable folder tree, alphabetical at every level; level 1 first (plus ticked branches) with "show more". */
export function FolderTreeFilter({ folders, loading, value, onChange, searchPlaceholder, emptyText, notFoundText }: {
  folders: FilterFolder[] | undefined; loading: boolean; value?: string[] | undefined; onChange: (ids: string[] | undefined) => void;
  searchPlaceholder: string; emptyText: string; notFoundText: string;
}) {
  const [search, setSearch] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const [rootLimit, setRootLimit] = useState(INITIAL_FOLDER_ROOTS);
  const deferred = useDeferredValue(search);
  const { treeData: full, matching } = useMemo(() => buildFolderTree(folders ?? [], deferred), [folders, deferred]);
  const treeData = useMemo(() => {
    const branch = new Set([...(value ?? []), ...ancestorIds(value ?? [], folders ?? [])]);
    return full.filter((n, i) => i < rootLimit || branch.has(String(n.key)));
  }, [full, rootLimit, value, folders]);
  const visibleKeys = useMemo(() => {
    const keys = new Set<string>();
    const walk = (list: DataNode[]) => list.forEach((n) => { keys.add(String(n.key)); if (n.children) walk(n.children); });
    walk(treeData);
    return keys;
  }, [treeData]);
  const searching = Boolean(deferred.trim());
  useEffect(() => setRootLimit(INITIAL_FOLDER_ROOTS), [search]);
  useEffect(() => {
    if (searching) setExpandedKeys([...matching]);
    else if (folders?.length) setExpandedKeys(ancestorIds(value ?? [], folders));
  }, [folders, searching, matching]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!value?.length || searching || !folders?.length) return;
    const up = ancestorIds(value, folders);
    setExpandedKeys((current) => { const missing = up.filter((id) => !current.includes(id)); return missing.length ? [...current, ...missing] : current; });
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Flex vertical gap={8}>
      <SearchInput value={search} onChange={setSearch} placeholder={searchPlaceholder} />
      <div style={{ marginInline: -4 }}>
        {loading ? <OptionListSkeleton indent={28} rowHeight={24} rowGap={4} /> : treeData.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={search ? notFoundText : emptyText} />
        ) : (
          <Tree
            checkable blockNode checkStrictly={searching} selectable={false} treeData={treeData}
            checkedKeys={(value ?? []).filter((id) => visibleKeys.has(id))} expandedKeys={expandedKeys} onExpand={(keys) => setExpandedKeys(keys)}
            onCheck={(checked) => {
              const keys = Array.isArray(checked) ? checked : checked.checked;
              const hidden = (value ?? []).filter((id) => !visibleKeys.has(id));
              const ids = withoutTickedDescendants([...hidden, ...keys.map(String)], folders ?? []);
              onChange(ids.length ? ids : undefined);
            }}
            style={{ background: "transparent" }}
          />
        )}
      </div>
      <ShowMoreLess hiddenCount={full.length - treeData.length} canCollapse={rootLimit > INITIAL_FOLDER_ROOTS}
        onMore={() => setRootLimit((c) => c + SHOW_MORE_STEP)} onLess={() => setRootLimit(INITIAL_FOLDER_ROOTS)} />
    </Flex>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Flex, Select } from "antd";
import { Folder as FolderIcon, Layers, MapPin, Tag as TagIcon, UserRound } from "lucide-react";
import { useAiTranslation } from "../../common/assistant-name";
import {
  ActiveFilterSummary, CheckboxListFilter, FilterSections, FolderTreeFilter, MoreFiltersToggle, useFilterSectionsOpen, type ActiveFilterChip,
  type FilterSectionItem,
} from "./filter-sidebar";
import { compareText } from "./text-match";
import { useAgGoLookups } from "./use-ag-go-lookups";

export type ProjectFilterValues = {
  keyword?: string | undefined;
  folderIds?: string[] | undefined;
  countryId?: string | undefined;
  provinceId?: string | undefined;
  categoryIds?: string[] | undefined;
  tagIds?: string[] | undefined;
  ownerUserIds?: string[] | undefined;
};

/** Filter groups in use (keyword, folder, location, category, tags, author). */
export function countActiveFilters(v: ProjectFilterValues): number {
  return [v.keyword?.trim(), v.folderIds?.length, v.countryId || v.provinceId, v.categoryIds?.length, v.tagIds?.length, v.ownerUserIds?.length].filter(Boolean).length;
}

type SectionKey = "category" | "tags" | "location" | "folder" | "author";
function activeSections(v: ProjectFilterValues): SectionKey[] {
  const on: [SectionKey, boolean][] = [
    ["category", Boolean(v.categoryIds?.length)], ["location", Boolean(v.countryId)], ["tags", Boolean(v.tagIds?.length)],
    ["folder", Boolean(v.folderIds?.length)], ["author", Boolean(v.ownerUserIds?.length)],
  ];
  return on.filter(([, x]) => x).map(([k]) => k);
}

const without = <T,>(values: T[] | undefined, value: T): T[] | undefined => {
  const next = (values ?? []).filter((x) => x !== value);
  return next.length ? next : undefined;
};

/** The filters in use as removable chips ("Danh mục: Khách sạn ×"); the keyword stays in the search box. */
function useProjectFilterChips(value: ProjectFilterValues, onChange: (v: ProjectFilterValues) => void, lookups: ReturnType<typeof useAgGoLookups>): ActiveFilterChip[] {
  const { t } = useAiTranslation();
  const { categories, tags, folders, countries, provinces, owners } = lookups;
  return useMemo(() => {
    const nameOf = (items: { id: string; name: string }[] | undefined, id: string) => items?.find((x) => x.id === id)?.name ?? "…";
    const out: { key: string; label: string; remove: () => ProjectFilterValues }[] = [];
    for (const id of value.categoryIds ?? []) out.push({ key: `category:${id}`, label: `${t("ws.agp.category")}: ${nameOf(categories.data, id)}`, remove: () => ({ ...value, categoryIds: without(value.categoryIds, id) }) });
    for (const id of value.tagIds ?? []) out.push({ key: `tag:${id}`, label: `${t("ws.agp.tags")}: ${nameOf(tags.data, id)}`, remove: () => ({ ...value, tagIds: without(value.tagIds, id) }) });
    if (value.countryId) {
      const place = [value.provinceId ? nameOf(provinces.data, value.provinceId) : null, nameOf(countries.data, value.countryId)].filter(Boolean).join(", ");
      out.push({ key: "location", label: `${t("ws.agp.location")}: ${place}`, remove: () => ({ ...value, countryId: undefined, provinceId: undefined }) });
    }
    for (const id of value.folderIds ?? []) {
      const f = folders.data?.find((x) => x.id === id);
      out.push({ key: `folder:${id}`, label: `${t("ws.agp.folder")}: ${f?.pathText || f?.name || "…"}`, remove: () => ({ ...value, folderIds: without(value.folderIds, id) }) });
    }
    for (const id of value.ownerUserIds ?? []) {
      const o = owners.data?.find((x) => x.id === id);
      out.push({ key: `author:${id}`, label: `${t("ws.agp.authorFilter")}: ${o?.user?.name || o?.user?.email || id}`, remove: () => ({ ...value, ownerUserIds: without(value.ownerUserIds, id) }) });
    }
    return out.map((c) => ({ key: c.key, label: c.label, onRemove: () => onChange(c.remove()) }));
  }, [value, onChange, t, categories.data, tags.data, folders.data, countries.data, provinces.data, owners.data]);
}

/**
 * ag-go's project filters as a vertical panel: category, location, tags and folder up front, the author behind "more
 * filters". Every change applies at once.
 */
export function ProjectFilterSidebar({ value, onChange }: { value: ProjectFilterValues; onChange: (v: ProjectFilterValues) => void }) {
  const { t } = useAiTranslation();
  const lookups = useAgGoLookups(true, { countryId: value.countryId });
  const { categories, tags, folders, countries, provinces, owners } = lookups;
  const chips = useProjectFilterChips(value, onChange, lookups);
  const hasExtra = Boolean(value.ownerUserIds?.length);
  const [showMore, setShowMore] = useState(hasExtra);
  const [openKeys, setOpenKeys] = useFilterSectionsOpen(["category", "location"], activeSections(value));
  useEffect(() => { if (hasExtra) setShowMore(true); }, [hasExtra]);
  const activeCount = countActiveFilters({ ...value, keyword: undefined });

  const main: FilterSectionItem[] = [
    {
      key: "category", icon: <Layers size={16} />, label: t("ws.agp.category"), count: value.categoryIds?.length ?? 0,
      onClear: () => onChange({ ...value, categoryIds: undefined }),
      children: (
        <CheckboxListFilter
          options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name, searchText: c.name }))} loading={categories.isPending}
          value={value.categoryIds} onChange={(ids) => onChange({ ...value, categoryIds: ids })}
          searchPlaceholder={t("ws.agp.searchCategoryPlaceholder")} emptyText={t("ws.agp.emptyCategory")} notFoundText={t("ws.agp.noCategoryFound")}
        />
      ),
    },
    {
      key: "location", icon: <MapPin size={16} />, label: t("ws.agp.location"), count: (value.countryId ? 1 : 0) + (value.provinceId ? 1 : 0),
      onClear: () => onChange({ ...value, countryId: undefined, provinceId: undefined }),
      children: (
        <Flex vertical gap={8}>
          <Select
            allowClear showSearch optionFilterProp="search" placeholder={t("ws.agp.countryPlaceholder")} aria-label={t("ws.agp.countryPlaceholder")}
            value={value.countryId} loading={countries.isPending} style={{ width: "100%" }}
            onChange={(v?: string) => onChange({ ...value, countryId: v, provinceId: undefined })}
            options={(countries.data ?? []).slice().sort((a, b) => compareText(a.name, b.name)).map((c) => ({
              value: c.id, search: `${c.name} ${c.code ?? ""}`,
              label: <Flex align="center" gap={6}>{c.flagUrl ? <img src={c.flagUrl} alt="" style={{ height: 12, borderRadius: 2 }} /> : null}<span>{c.name}</span></Flex>,
            }))}
          />
          <Select
            allowClear showSearch optionFilterProp="label" disabled={!value.countryId} loading={Boolean(value.countryId) && provinces.isPending}
            placeholder={t("ws.agp.provincePlaceholder")} aria-label={t("ws.agp.provincePlaceholder")} value={value.provinceId} style={{ width: "100%" }}
            onChange={(v?: string) => onChange({ ...value, provinceId: v })}
            options={(provinces.data ?? []).map((p) => ({ value: p.id, label: p.name })).sort((a, b) => compareText(a.label, b.label))}
          />
        </Flex>
      ),
    },
    {
      key: "tags", icon: <TagIcon size={16} />, label: t("ws.agp.tags"), count: value.tagIds?.length ?? 0, onClear: () => onChange({ ...value, tagIds: undefined }),
      children: (
        <CheckboxListFilter
          options={(tags.data ?? []).map((x) => ({ value: x.id, label: x.name, searchText: x.name }))} loading={tags.isPending}
          value={value.tagIds} onChange={(ids) => onChange({ ...value, tagIds: ids })}
          searchPlaceholder={t("ws.agp.searchTagPlaceholder")} emptyText={t("ws.agp.emptyTag")} notFoundText={t("ws.agp.noTagFound")}
        />
      ),
    },
    {
      key: "folder", icon: <FolderIcon size={16} />, label: t("ws.agp.folder"), count: value.folderIds?.length ?? 0,
      onClear: () => onChange({ ...value, folderIds: undefined }),
      children: (
        <FolderTreeFilter
          folders={folders.data} loading={folders.isPending} value={value.folderIds} onChange={(ids) => onChange({ ...value, folderIds: ids })}
          searchPlaceholder={t("ws.agp.searchFolderPlaceholder")} emptyText={t("ws.agp.emptyFolder")} notFoundText={t("ws.agp.noFolderFound")}
        />
      ),
    },
  ];
  const extra: FilterSectionItem[] = [{
    key: "author", icon: <UserRound size={16} />, label: t("ws.agp.authorFilter"), count: value.ownerUserIds?.length ?? 0,
    onClear: () => onChange({ ...value, ownerUserIds: undefined }),
    children: (
      <CheckboxListFilter
        options={(owners.data ?? []).map((o) => {
          const name = o.user?.name || o.user?.email || o.id;
          return { value: o.id, label: name, searchText: `${name} ${o.user?.email ?? ""}`, count: o.projectCount };
        })}
        loading={owners.isPending} value={value.ownerUserIds} onChange={(ids) => onChange({ ...value, ownerUserIds: ids })}
        searchPlaceholder={t("ws.agp.searchAuthorPlaceholder")} emptyText={t("ws.agp.emptyAuthor")} notFoundText={t("ws.agp.noAuthorFound")}
      />
    ),
  }];

  return (
    <Flex vertical className="agp-filter-sidebar">
      <ActiveFilterSummary count={activeCount} chips={chips} />
      <FilterSections items={main} openKeys={openKeys} onOpenKeysChange={setOpenKeys} borderFirst={activeCount > 0} />
      {showMore ? <FilterSections items={extra} openKeys={openKeys} onOpenKeysChange={setOpenKeys} /> : null}
      <MoreFiltersToggle open={showMore} onToggle={() => setShowMore((c) => !c)} />
    </Flex>
  );
}

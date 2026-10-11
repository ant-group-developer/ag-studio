import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AutoComplete, Flex, Input, Typography, theme } from "antd";
import { useQuery } from "@tanstack/react-query";
import { Folder as FolderIcon, Layers, MapPin, Search, Tag as TagIcon } from "lucide-react";
import { useAgGoClient } from "../../../api/ag-go-client";
import { useAiTranslation } from "../../common/assistant-name";
import { useDebounced } from "../picker/PickerParts";
import { compareText, highlightText, matchesWords, normalizeSearchText, searchWords } from "./text-match";
import { useAgGoLookups } from "./use-ag-go-lookups";

/** A filter value picked from the search suggestions. */
export type ProjectSearchSuggestion =
  | { kind: "category" | "tag" | "folder" | "country"; id: string }
  | { kind: "province"; id: string; countryId: string };

const SEARCH_ALL = "__search_all__";
const MAX_PER_GROUP = 5;

type Candidate = { suggestion: ProjectSearchSuggestion; label: string; normalized: string };
const candidate = (suggestion: ProjectSearchSuggestion, label: string, searchText = label): Candidate => ({ suggestion, label, normalized: normalizeSearchText(searchText) });
const byLabel = (a: Candidate, b: Candidate) => compareText(a.label, b.label);

/**
 * The keyword box of ag-go's Projects page: it also suggests categories, tags, folders and places matching what is
 * typed (no diacritics, any word order); picking one filters by it, Enter searches every field of the projects.
 */
export function ProjectSearchBox({ keyword, onSearch, onPick }: {
  keyword: string; onSearch: (keyword: string) => void; onPick: (s: ProjectSearchSuggestion) => void;
}) {
  const { t } = useAiTranslation();
  const { token } = theme.useToken();
  const agGo = useAgGoClient();
  const [value, setValue] = useState(keyword);
  useEffect(() => setValue(keyword), [keyword]);
  const query = useDeferredValue(value.trim());
  const hasQuery = query.length > 0;
  const { categories, tags, folders, countries } = useAgGoLookups(true);
  // Provinces of every country are too many to load, so they are looked up by keyword.
  const provinceKeyword = useDebounced(query, 250);
  const provinces = useQuery({
    queryKey: ["agGo", "provinces-found", provinceKeyword], queryFn: () => agGo.findProvinces(provinceKeyword),
    enabled: provinceKeyword.length >= 2, staleTime: 300_000, retry: false,
  });
  // The Enter that picks a suggestion must not also run a keyword search.
  const pickedAt = useRef(0);

  const categoryCandidates = useMemo(() => (categories.data ?? []).map((c) => candidate({ kind: "category", id: c.id }, c.name)).sort(byLabel), [categories.data]);
  const tagCandidates = useMemo(() => (tags.data ?? []).map((x) => candidate({ kind: "tag", id: x.id }, x.name)).sort(byLabel), [tags.data]);
  const folderCandidates = useMemo(() => (folders.data ?? []).map((f) => candidate({ kind: "folder", id: f.id }, f.pathText || f.name)).sort(byLabel), [folders.data]);
  const countryCandidates = useMemo(() => (countries.data ?? []).map((c) => candidate({ kind: "country", id: c.id }, c.name, `${c.name} ${c.code ?? ""}`)).sort(byLabel), [countries.data]);

  const groups = useMemo(() => {
    if (!hasQuery) return [];
    const words = searchWords(query);
    const pick = (list: Candidate[]) => {
      const out: Candidate[] = [];
      for (const item of list) if (matchesWords(words, item.normalized) && out.push(item) === MAX_PER_GROUP) break;
      return out;
    };
    return [
      { key: "category", title: t("ws.agp.category"), icon: <Layers size={14} />, items: pick(categoryCandidates) },
      { key: "tag", title: t("ws.agp.tags"), icon: <TagIcon size={14} />, items: pick(tagCandidates) },
      { key: "folder", title: t("ws.agp.folder"), icon: <FolderIcon size={14} />, items: pick(folderCandidates) },
      {
        key: "location", title: t("ws.agp.location"), icon: <MapPin size={14} />, items: pick([
          ...countryCandidates,
          ...(provinces.data ?? []).map((p) => candidate({ kind: "province", id: p.id, countryId: p.countryId }, [p.name, p.country?.name].filter(Boolean).join(", "))).sort(byLabel),
        ]),
      },
    ].filter((g) => g.items.length > 0);
  }, [hasQuery, query, t, categoryCandidates, tagCandidates, folderCandidates, countryCandidates, provinces.data]);

  const byValue = new Map<string, ProjectSearchSuggestion>();
  const groupTitle = (icon: ReactNode, title: string) => <Flex align="center" gap={6} style={{ color: token.colorTextSecondary }}>{icon}<span>{title}</span></Flex>;
  const options = hasQuery ? [
    { value: SEARCH_ALL, label: <Flex align="center" gap={8}><Search size={14} /><Typography.Text ellipsis>{t("ws.agp.searchAllFor", { keyword: value.trim() })}</Typography.Text></Flex> },
    ...groups.map((g) => ({
      label: groupTitle(g.icon, g.title),
      options: g.items.map((item) => {
        const key = `${item.suggestion.kind}:${item.suggestion.id}`;
        byValue.set(key, item.suggestion);
        return { value: key, label: <Typography.Text ellipsis title={item.label}>{highlightText(item.label, query)}</Typography.Text> };
      }),
    })),
  ] : [];

  const runSearch = (kw: string) => {
    window.setTimeout(() => { if (Date.now() - pickedAt.current > 300) onSearch(kw.trim()); });
  };

  return (
    <AutoComplete
      value={value} options={options} filterOption={false} popupMatchSelectWidth={420} style={{ width: "clamp(220px, 24vw, 380px)" }}
      onSelect={(selected: string) => {
        pickedAt.current = Date.now();
        if (selected === SEARCH_ALL) { onSearch(value.trim()); return; }
        const s = byValue.get(selected);
        if (s) { setValue(""); onPick(s); }
      }}
    >
      <Input
        allowClear placeholder={t("ws.agp.smartSearchPlaceholder")} aria-label={t("ws.agp.smartSearchPlaceholder")}
        prefix={<Search size={16} style={{ color: token.colorTextQuaternary }} />} value={value}
        onChange={(e) => { setValue(e.target.value); if (e.type === "click" && !e.target.value) onSearch(""); }}
        onPressEnter={(e) => runSearch((e.target as HTMLInputElement).value)}
      />
    </AutoComplete>
  );
}

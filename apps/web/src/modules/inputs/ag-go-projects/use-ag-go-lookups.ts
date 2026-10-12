import { useQuery } from "@tanstack/react-query";
import { useAgGoClient } from "../../../api/ag-go-client";

const LOOKUP = { staleTime: 300_000, retry: false } as const;

/** The lists ag-go's project filters and search box offer, loaded once and shared (cached 5 minutes). */
export function useAgGoLookups(enabled: boolean, opts: { countryId?: string | undefined; owners?: boolean } = {}) {
  const agGo = useAgGoClient();
  return {
    categories: useQuery({ queryKey: ["agGo", "categories"], queryFn: () => agGo.getCategories(), enabled, ...LOOKUP }),
    tags: useQuery({ queryKey: ["agGo", "tags"], queryFn: () => agGo.getTags(), enabled, ...LOOKUP }),
    folders: useQuery({ queryKey: ["agGo", "folders"], queryFn: () => agGo.getFolderTree(), enabled, ...LOOKUP }),
    countries: useQuery({ queryKey: ["agGo", "countries"], queryFn: () => agGo.getCountries(), enabled, ...LOOKUP }),
    owners: useQuery({ queryKey: ["agGo", "owners"], queryFn: () => agGo.getProjectOwners(), enabled: enabled && opts.owners !== false, ...LOOKUP }),
    provinces: useQuery({
      queryKey: ["agGo", "provinces", opts.countryId], queryFn: () => agGo.getProvinces(opts.countryId!), enabled: enabled && Boolean(opts.countryId), ...LOOKUP,
    }),
  };
}

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../../api/studio-client";
import { getAgGoPublicSettings } from "../../api/ag-go-client";

/** What the web calls the AI until a Studio admin names it (`assistant.name` in `studio_settings`). */
export const DEFAULT_ASSISTANT_NAME = "Claude";
/** What the web calls the footage library until ag-go answers with its own name (`siteName` of its settings). */
export const DEFAULT_SITE_NAME = "AG Go";

const AssistantName = createContext(DEFAULT_ASSISTANT_NAME);
const SiteName = createContext(DEFAULT_SITE_NAME);

/** Reads the name once for the whole app; the header chip's polling of the same query keeps it fresh. */
export function AssistantNameProvider({ children }: { children: ReactNode }) {
  const client = useStudioClient();
  const { data } = useQuery({ queryKey: ["claude-usage"], queryFn: () => client.getClaudeUsage(), staleTime: 60_000 });
  return <AssistantName.Provider value={data?.assistantName || DEFAULT_ASSISTANT_NAME}>{children}</AssistantName.Provider>;
}

/** A name fit to show: one line, 1–60 characters. */
function siteNameOf(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name) ? name : DEFAULT_SITE_NAME;
}

/**
 * ag-go's own name, from its public settings (no sign-in needed, so the login screen has it too). Mounted outside
 * `AuthGate`; ag-go out of reach leaves "AG Go".
 */
export function SiteNameProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({ queryKey: ["ag-go-site-name"], queryFn: getAgGoPublicSettings, staleTime: 600_000, retry: false });
  return <SiteName.Provider value={siteNameOf(data?.siteName)}>{children}</SiteName.Provider>;
}

export function useAssistantName(): string {
  return useContext(AssistantName);
}

export function useSiteName(): string {
  return useContext(SiteName);
}

/**
 * `useTranslation` whose `t` fills `{{ai}}` with the AI's name and `{{site}}` with the footage library's (a call
 * may still pass its own).
 */
export function useAiTranslation() {
  const r = useTranslation();
  const ai = useAssistantName();
  const site = useSiteName();
  const base = r.t;
  const t = useCallback((key: string, options?: Record<string, unknown>): string => base(key, { ai, site, ...options }) as string, [base, ai, site]);
  return { ...r, t };
}

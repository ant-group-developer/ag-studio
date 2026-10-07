import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStudioClient } from "../../api/studio-client";

/** What the web calls the AI until a Studio admin names it (`assistant.name` in `studio_settings`). */
export const DEFAULT_ASSISTANT_NAME = "Claude";

const AssistantName = createContext(DEFAULT_ASSISTANT_NAME);

/** Reads the name once for the whole app; the header chip's polling of the same query keeps it fresh. */
export function AssistantNameProvider({ children }: { children: ReactNode }) {
  const client = useStudioClient();
  const { data } = useQuery({ queryKey: ["claude-usage"], queryFn: () => client.getClaudeUsage(), staleTime: 60_000 });
  return <AssistantName.Provider value={data?.assistantName || DEFAULT_ASSISTANT_NAME}>{children}</AssistantName.Provider>;
}

export function useAssistantName(): string {
  return useContext(AssistantName);
}

/** `useTranslation` whose `t` fills `{{ai}}` with the AI's name (a call may still pass its own `ai`). */
export function useAiTranslation() {
  const r = useTranslation();
  const ai = useAssistantName();
  const base = r.t;
  const t = useCallback((key: string, options?: Record<string, unknown>): string => base(key, { ai, ...options }) as string, [base, ai]);
  return { ...r, t };
}

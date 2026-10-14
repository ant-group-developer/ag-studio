import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStudioClient, type OnboardingProgress, type OnboardingStepKey, type UserPrefs, type UserPrefsPatch } from "../../api/studio-client";

/** The person's own UI prefs: tours seen, checklist hidden. */
export function usePrefs() {
  const client = useStudioClient();
  return useQuery({ queryKey: ["prefs"], queryFn: () => client.getPrefs(), staleTime: 5 * 60_000 });
}

/** Changes some prefs; the page shows the change at once (and keeps it if the save fails, until the next read). */
export function useUpdatePrefs() {
  const client = useStudioClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UserPrefsPatch) => client.updatePrefs(patch),
    onMutate: (patch) => {
      qc.setQueryData<UserPrefs>(["prefs"], (old) => old && {
        tourSeen: { ...old.tourSeen, ...patch.tourSeen },
        checklistHidden: patch.checklistHidden ?? old.checklistHidden,
      });
    },
    onSuccess: (prefs) => qc.setQueryData(["prefs"], prefs),
  });
}

/** The getting started progress; read again when a page opens, so steps done elsewhere tick. */
export function useOnboarding(enabled = true) {
  const client = useStudioClient();
  return useQuery({ queryKey: ["onboarding"], queryFn: () => client.getOnboarding(), enabled, staleTime: 15_000 });
}

/** The section of the guide page that explains each step ("How to"). */
export const GUIDE_SECTION: Record<OnboardingStepKey, string> = {
  team: "teams", project: "projects", footage: "footage", video: "video", chat: "chat", preview: "renders", final: "renders",
};

/**
 * Where "Go to" leads for a step: the page where it is done, in the team, project or video worked in last; a step
 * whose place does not exist yet leads to the step before it.
 */
export function stepTarget(key: OnboardingStepKey, links: OnboardingProgress["links"]): string {
  const team = links.teamId ? `/t/${links.teamId}` : "/";
  const project = links.projectId ? `/p/${links.projectId}` : team;
  const video = links.video ? `/p/${links.video.projectId}/v/${links.video.videoId}` : project;
  switch (key) {
    case "team":
    case "project":
      return team;
    case "footage":
      return links.projectId ? `${project}?tab=inputs` : team;
    case "video":
      return project;
    case "chat":
      return video;
    case "preview":
    case "final":
      return links.video ? `${video}?tab=preview` : project;
  }
}

import { useQuery } from "@tanstack/react-query";
import { useStudioClient, type TeamRole } from "../../api/studio-client";
import { useTeams } from "./WorkspaceShell";

const ORDER: TeamRole[] = ["viewer", "editor", "producer", "owner"];

/** The person's role in a team (a Studio admin counts as owner), and whether it reaches a given role. */
export function useTeamRole(teamId: string | undefined) {
  const client = useStudioClient();
  const { data: teams } = useTeams();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const role: TeamRole | null = me?.isAdmin ? "owner" : teams?.items.find((x) => x.id === teamId)?.role ?? null;
  const atLeast = (wanted: TeamRole) => role !== null && ORDER.indexOf(role) >= ORDER.indexOf(wanted);
  return { role, atLeast, teamName: teams?.items.find((x) => x.id === teamId)?.name };
}

import { useQuery } from "@tanstack/react-query";
import { useStudioClient, type TeamRole } from "../../api/studio-client";
import { useTeam } from "./WorkspaceShell";

const ORDER: TeamRole[] = ["viewer", "editor", "producer", "owner"];

/**
 * The person's role in a team (a Studio admin counts as owner, in the teams they are not in too), whether it reaches a
 * given role, and the team's name from `GET /teams/:id`. `ready` is false until both `/me` and the team have answered,
 * so a page does not flash read-only while they load.
 */
export function useTeamRole(teamId: string | undefined) {
  const client = useStudioClient();
  const team = useTeam(teamId);
  const me = useQuery({ queryKey: ["me"], queryFn: () => client.getMe(), staleTime: 5 * 60_000 });
  const role: TeamRole | null = me.data?.isAdmin ? "owner" : team.data?.role ?? null;
  const atLeast = (wanted: TeamRole) => role !== null && ORDER.indexOf(role) >= ORDER.indexOf(wanted);
  const ready = !!teamId && !me.isPending && !team.isPending;
  return { role, atLeast, ready, teamName: team.data?.name, isMember: team.data?.isMember ?? false };
}

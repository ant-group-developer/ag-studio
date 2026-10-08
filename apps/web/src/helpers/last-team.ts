/** The team a person worked in last (new productions go there by default); survives reloads, not private mode. */
const LAST_TEAM_KEY = "ag-studio:last-team";

export function rememberedTeam(): string | null {
  try {
    return localStorage.getItem(LAST_TEAM_KEY);
  } catch {
    return null;
  }
}

export function rememberTeam(teamId: string): void {
  try {
    localStorage.setItem(LAST_TEAM_KEY, teamId);
  } catch {
    // private mode
  }
}

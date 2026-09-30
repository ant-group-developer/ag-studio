/** Sider entry a page belongs to: the team list and a team's members under "Nhóm", everything else (production
 * lists, a production, its editor) under "Production". */
export function menuKeyFor(pathname: string): "/productions" | "/teams" {
  return /^\/teams\/?$/.test(pathname) || /^\/teams\/[^/]+\/?$/.test(pathname) ? "/teams" : "/productions";
}

/** Sider entry a page belongs to: the team list and a team's members under "Nhóm", the admin list under "Tất cả
 * production", everything else (production lists, a production, its editor) under "Production". */
export function menuKeyFor(pathname: string): "/productions" | "/all-productions" | "/teams" {
  if (/^\/all-productions\/?$/.test(pathname)) return "/all-productions";
  return /^\/teams\/?$/.test(pathname) || /^\/teams\/[^/]+\/?$/.test(pathname) ? "/teams" : "/productions";
}

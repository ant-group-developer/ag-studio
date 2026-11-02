import { useSyncExternalStore } from "react";

/** Auth0 trả các mã này khi refresh token đã bị thu hồi hoặc hết hạn: gọi lại cũng chỉ hỏng tiếp, phải đăng nhập lại. */
const SESSION_ERRORS = new Set(["invalid_grant", "missing_refresh_token", "login_required", "consent_required", "interaction_required"]);

let expired = false;
const listeners = new Set<() => void>();

export function isAuthSessionError(error: unknown): boolean {
  const code = (error as { error?: unknown } | null)?.error;
  return typeof code === "string" && SESSION_ERRORS.has(code);
}

export function isSessionExpired(): boolean {
  return expired;
}

export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, isSessionExpired);
}

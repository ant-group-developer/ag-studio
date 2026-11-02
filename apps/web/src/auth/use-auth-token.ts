import { useCallback } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { isAuthSessionError, isSessionExpired, markSessionExpired } from "./session-expiry";

/** The bearer token for Studio's API. `getAccessToken` stays the same function across renders, so a client made
 *  from it (`useWorkspaceClient`) does too, and effects that list the client do not run again on every render.
 *  Once Auth0 refuses the refresh token, it stops asking (each ask would fail the same way) and `AuthGate` shows
 *  the sign-in-again screen. */
export function useAuthToken() {
  const { getAccessTokenSilently } = useAuth0();

  const getAccessToken = useCallback(async (): Promise<string> => {
    if (isSessionExpired()) throw new Error("Session expired");
    let token: string | undefined;
    try {
      token = await getAccessTokenSilently();
    } catch (error) {
      if (isAuthSessionError(error)) markSessionExpired();
      throw error;
    }
    if (!token) throw new Error("Failed to get access token");
    return token;
  }, [getAccessTokenSilently]);

  return { getAccessToken };
}

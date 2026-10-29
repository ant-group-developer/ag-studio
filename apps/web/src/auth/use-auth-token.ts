import { useCallback } from "react";
import { useAuth0 } from "@auth0/auth0-react";

/** The bearer token for Studio's API. `getAccessToken` stays the same function across renders, so a client made
 *  from it (`useWorkspaceClient`) does too, and effects that list the client do not run again on every render. */
export function useAuthToken() {
  const { getAccessTokenSilently } = useAuth0();

  const getAccessToken = useCallback(async (): Promise<string> => {
    const token = await getAccessTokenSilently();
    if (!token) throw new Error("Failed to get access token");
    return token;
  }, [getAccessTokenSilently]);

  return { getAccessToken };
}

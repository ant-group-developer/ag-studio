import { useCallback } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { getSegmentMedia } from "../../api/ag-go-client";
import type { MediaLookup } from "./media";

/**
 * `media` prop wired to ag-go with the viewer's own Auth0 token: ag-go enforces the viewer's own footage
 * scope, so this never needs the production's owner token. Any failure (network, out of scope, ...) resolves
 * to `null` -- callers fall back to text, never an error page.
 */
export function useSegmentMedia(): MediaLookup {
  const { getAccessTokenSilently } = useAuth0();
  return useCallback(
    async (segmentId: string) => {
      try {
        const token = await getAccessTokenSilently();
        if (!token) return null;
        return await getSegmentMedia(token, segmentId);
      } catch {
        return null;
      }
    },
    [getAccessTokenSilently]
  );
}

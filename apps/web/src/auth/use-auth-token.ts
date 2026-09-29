import { useAuth0 } from "@auth0/auth0-react";

export function useAuthToken() {
  const { getAccessTokenSilently } = useAuth0();

  const getAccessToken = async (): Promise<string> => {
    const token = await getAccessTokenSilently();
    if (!token) throw new Error("Failed to get access token");
    return token;
  };

  return { getAccessToken };
}

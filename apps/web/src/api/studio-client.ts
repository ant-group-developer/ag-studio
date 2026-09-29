import { useAuthToken } from "../auth/use-auth-token";

const STUDIO_API_URL =
  (import.meta.env.VITE_STUDIO_API_URL as string | undefined) ??
  "http://localhost:3100";

export interface Team {
  id: string;
  name: string;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  role: string;
  joinedAt: string;
}

export interface Production {
  id: string;
  teamId: string;
  title: string;
  brief: string;
  status: string;
  aspectRatio: string;
  canvasWidth: number;
  canvasHeight: number;
  sources: string[];
  createdAt: string;
}

export interface CreateProductionData {
  title: string;
  brief: string;
  aspectRatio: string;
  folderIds: string[];
}

export interface UpdateProductionData {
  title: string;
  brief: string;
  status: string;
}

export interface ProductionAccess {
  hasAccess: boolean;
}

async function request<T>(
  getAccessToken: () => Promise<string>,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${STUDIO_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function createStudioClient(getAccessToken: () => Promise<string>) {
  return {
    createTeam(name: string): Promise<Team> {
      return request<Team>(getAccessToken, "POST", "/api/teams", { name });
    },

    listTeams(): Promise<Team[]> {
      return request<Team[]>(getAccessToken, "GET", "/api/teams");
    },

    listMembers(teamId: string): Promise<TeamMember[]> {
      return request<TeamMember[]>(
        getAccessToken,
        "GET",
        `/api/teams/${teamId}/members`
      );
    },

    addMember(
      teamId: string,
      userId: string,
      role: string
    ): Promise<TeamMember> {
      return request<TeamMember>(
        getAccessToken,
        "POST",
        `/api/teams/${teamId}/members`,
        { userId, role }
      );
    },

    removeMember(teamId: string, userId: string): Promise<void> {
      return request<void>(
        getAccessToken,
        "DELETE",
        `/api/teams/${teamId}/members/${userId}`
      );
    },

    updateMemberRole(
      teamId: string,
      userId: string,
      role: string
    ): Promise<TeamMember> {
      return request<TeamMember>(
        getAccessToken,
        "PATCH",
        `/api/teams/${teamId}/members/${userId}`,
        { role }
      );
    },

    createProduction(
      teamId: string,
      data: CreateProductionData
    ): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "POST",
        `/api/teams/${teamId}/productions`,
        data
      );
    },

    listProductions(teamId: string): Promise<Production[]> {
      return request<Production[]>(
        getAccessToken,
        "GET",
        `/api/teams/${teamId}/productions`
      );
    },

    getProduction(id: string): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "GET",
        `/api/productions/${id}`
      );
    },

    updateProduction(
      id: string,
      data: Partial<UpdateProductionData>
    ): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "PATCH",
        `/api/productions/${id}`,
        data
      );
    },

    setProductionSources(id: string, folderIds: string[]): Promise<Production> {
      return request<Production>(
        getAccessToken,
        "POST",
        `/api/productions/${id}/sources`,
        { folderIds }
      );
    },

    checkProductionAccess(id: string): Promise<ProductionAccess> {
      return request<ProductionAccess>(
        getAccessToken,
        "GET",
        `/api/productions/${id}/access`
      );
    },
  };
}

export type StudioClient = ReturnType<typeof createStudioClient>;

export function useStudioClient(): StudioClient {
  const { getAccessToken } = useAuthToken();
  return createStudioClient(getAccessToken);
}

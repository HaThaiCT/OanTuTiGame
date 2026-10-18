export interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly statusCode: number;
}

export class V2ApiClient {
  constructor(private readonly baseUrl: string = '/api/v2') {}

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      const statusCode = res.status;
      if (statusCode === 204) {
        return { success: true, statusCode };
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          error: json.error || json.message || `Request failed with status ${statusCode}`,
          statusCode,
        };
      }

      return { success: true, data: json as T, statusCode };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Network connection failed',
        statusCode: 0,
      };
    }
  }

  // --- Auth ---
  async getMe() {
    return this.request<{ user: { id: string; username: string; role: string; teamIds: string[] } }>('/auth/me');
  }

  async login(username: string, passwordHash: string) {
    return this.request<{ user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, passwordHash }),
    });
  }

  async logout() {
    return this.request<void>('/auth/logout', { method: 'POST' });
  }

  // --- Tournaments ---
  async listTournaments() {
    return this.request<{ tournaments: any[] }>('/tournaments');
  }

  async getTournament(id: string) {
    return this.request<any>(`/tournaments/${id}`);
  }

  async lockTournament(id: string) {
    return this.request<any>(`/organizer/tournaments/${id}/lock`, { method: 'POST' });
  }

  async startTournament(id: string) {
    return this.request<any>(`/organizer/tournaments/${id}/start`, { method: 'POST' });
  }

  async finalizeTournament(id: string) {
    return this.request<any>(`/organizer/tournaments/${id}/finalize`, { method: 'POST' });
  }

  // --- Submissions & Private Tests ---
  async submitSource(tournamentId: string, teamId: string, payload: { language: string; entrypoint: string; zipBase64: string }) {
    return this.request<any>(`/tournaments/${tournamentId}/submissions`, {
      method: 'POST',
      body: JSON.stringify({ teamId, ...payload }),
    });
  }

  async createPrivateTest(tournamentId: string, teamId: string, payload: { language: string; entrypoint: string; zipBase64: string; opponentType: string }) {
    return this.request<any>(`/tournaments/${tournamentId}/private-tests`, {
      method: 'POST',
      body: JSON.stringify({ teamId, ...payload }),
    });
  }

  async getLatestCandidate(tournamentId: string) {
    return this.request<any>(`/tournaments/${tournamentId}/entries/me`);
  }

  // --- Results & Replays ---
  async getGameResult(gameId: string) {
    return this.request<any>(`/games/${gameId}/result`);
  }

  async downloadReplay(gameId: string): Promise<Blob | null> {
    const res = await fetch(`${this.baseUrl}/games/${gameId}/replay`);
    if (!res.ok) return null;
    return res.blob();
  }

  // --- Disputes & Corrections ---
  async listDisputes(tournamentId: string) {
    return this.request<{ disputes: any[] }>(`/tournaments/${tournamentId}/disputes`);
  }

  async fileDispute(tournamentId: string, payload: { encounterId: string; teamId: string; reason: string }) {
    return this.request<any>(`/tournaments/${tournamentId}/disputes`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async resolveDispute(disputeId: string, payload: { decision: 'RESOLVED' | 'REJECTED'; note: string }) {
    return this.request<any>(`/organizer/disputes/${disputeId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
}

export const api = new V2ApiClient();

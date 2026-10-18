export interface DraftState {
  readonly teamId: string;
  readonly language: 'PYTHON' | 'TYPESCRIPT' | 'CPP';
  readonly activeFile: string;
  readonly files: Record<string, string>;
  readonly lastModified: string;
}
export class DraftPreserver {
  private static memoryStore = new Map<string, string>();

  private static getKey(teamId: string): string {
    return `oantuti_draft_${teamId}`;
  }

  static saveDraft(draft: DraftState): void {
    const raw = JSON.stringify(draft);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(this.getKey(draft.teamId), raw);
      } else {
        this.memoryStore.set(this.getKey(draft.teamId), raw);
      }
    } catch {
      this.memoryStore.set(this.getKey(draft.teamId), raw);
    }
  }

  static loadDraft(teamId: string): DraftState | null {
    try {
      let raw: string | null = null;
      if (typeof window !== 'undefined' && window.localStorage) {
        raw = window.localStorage.getItem(this.getKey(teamId));
      } else {
        raw = this.memoryStore.get(this.getKey(teamId)) ?? null;
      }
      if (raw) return JSON.parse(raw) as DraftState;
    } catch {
      // JSON parse error
    }
    return null;
  }

  static clearDraft(teamId: string): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(this.getKey(teamId));
      } else {
        this.memoryStore.delete(this.getKey(teamId));
      }
    } catch {
      this.memoryStore.delete(this.getKey(teamId));
    }
  }
}

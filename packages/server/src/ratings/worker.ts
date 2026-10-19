import type { GlobalTeamRatingService } from './service.js';

/** Process-local coalescer; database revision and advisory locking remain authoritative. */
export class GlobalRatingWorker {
  private active?: Promise<void>;
  private stopping = false;
  constructor(private readonly service: GlobalTeamRatingService) {}
  kick(): void {
    if (this.stopping || this.active) return;
    this.active = this.service.rebuildPending().catch((error) => console.warn(`[global-rating-worker] ${error instanceof Error ? error.message : String(error)}`)).finally(() => { this.active = undefined; });
  }
  async stop(): Promise<void> { this.stopping = true; await this.active; }
}

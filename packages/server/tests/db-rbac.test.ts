import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/db.js';

describe('Database RBAC & Admin Seed', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('automatically seeds default admin user with role ADMIN', () => {
    const admin = db.getUserByUsername('admin');
    expect(admin).toBeDefined();
    expect(admin?.role).toBe('ADMIN');
    expect(admin?.email).toBe('admin@oantuti.arena');
  });

  it('defaults new user creation to role PLAYER', () => {
    const player = db.createUser({
      username: 'lan_player_1',
      email: 'player1@lan.local',
      password_hash: 'scrypt$dummy$hash',
    });
    expect(player.role).toBe('PLAYER');

    const fetched = db.getUserById(player.id);
    expect(fetched?.role).toBe('PLAYER');
  });

  it('persists projected index in tournament configuration', () => {
    const admin = db.getUserByUsername('admin')!;
    const tour = db.createTournament({
      creatorId: admin.id,
      name: 'LAN Championship 2026',
      format: 'ROUND_ROBIN',
      configJson: JSON.stringify({ botIds: [], mapId: 'sample-donut', projectedIndex: 0 }),
    });

    expect(JSON.parse(tour.config_json).projectedIndex).toBe(0);

    db.updateTournamentProjectedIndex(tour.id, 3);
    const updated = db.getTournamentById(tour.id)!;
    const cfg = JSON.parse(updated.config_json);
    expect(cfg.projectedIndex).toBe(3);
  });
});

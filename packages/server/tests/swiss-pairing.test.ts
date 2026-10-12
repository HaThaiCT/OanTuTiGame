import { describe, it, expect } from 'vitest';
import { generateSwissPairings, StandingEntry } from '../src/tournament-service.js';

describe('Swiss System Pairing Algorithm', () => {
  it('pairs all bots in round 1 with no previous matches', () => {
    const standings: StandingEntry[] = [
      { botId: 'bot_1', botName: 'Bot 1', language: 'TS', matchesPlayed: 0, wins: 0, losses: 0, draws: 0, points: 0, elo: 1400 },
      { botId: 'bot_2', botName: 'Bot 2', language: 'TS', matchesPlayed: 0, wins: 0, losses: 0, draws: 0, points: 0, elo: 1300 },
      { botId: 'bot_3', botName: 'Bot 3', language: 'TS', matchesPlayed: 0, wins: 0, losses: 0, draws: 0, points: 0, elo: 1200 },
      { botId: 'bot_4', botName: 'Bot 4', language: 'TS', matchesPlayed: 0, wins: 0, losses: 0, draws: 0, points: 0, elo: 1100 },
    ];

    const result = generateSwissPairings(standings, new Set<string>(), new Set<string>());
    expect(result.pairings.length).toBe(2);
    expect(result.byeBotId).toBeUndefined();

    // Verify all 4 bots are paired
    const pairedBots = new Set<string>();
    for (const p of result.pairings) {
      pairedBots.add(p.whiteBotId);
      pairedBots.add(p.blackBotId);
    }
    expect(pairedBots.size).toBe(4);
  });

  it('pairs winners with winners and prevents rematches in round 2', () => {
    const standings: StandingEntry[] = [
      { botId: 'bot_1', botName: 'Bot 1', language: 'TS', matchesPlayed: 1, wins: 1, losses: 0, draws: 0, points: 3, elo: 1400 },
      { botId: 'bot_2', botName: 'Bot 2', language: 'TS', matchesPlayed: 1, wins: 1, losses: 0, draws: 0, points: 3, elo: 1300 },
      { botId: 'bot_3', botName: 'Bot 3', language: 'TS', matchesPlayed: 1, wins: 0, losses: 1, draws: 0, points: 0, elo: 1200 },
      { botId: 'bot_4', botName: 'Bot 4', language: 'TS', matchesPlayed: 1, wins: 0, losses: 1, draws: 0, points: 0, elo: 1100 },
    ];

    // Previous matches: bot_1 played bot_3, bot_2 played bot_4
    const previousPairs = new Set<string>([
      'bot_1:bot_3', 'bot_3:bot_1',
      'bot_2:bot_4', 'bot_4:bot_2',
    ]);

    const result = generateSwissPairings(standings, previousPairs, new Set<string>());
    expect(result.pairings.length).toBe(2);

    // Round 2 must pair the two 3-point bots (bot_1 vs bot_2) and the two 0-point bots (bot_3 vs bot_4)
    const pair1 = result.pairings.find(p => (p.whiteBotId === 'bot_1' && p.blackBotId === 'bot_2') || (p.whiteBotId === 'bot_2' && p.blackBotId === 'bot_1'));
    const pair2 = result.pairings.find(p => (p.whiteBotId === 'bot_3' && p.blackBotId === 'bot_4') || (p.whiteBotId === 'bot_4' && p.blackBotId === 'bot_3'));

    expect(pair1).toBeDefined();
    expect(pair2).toBeDefined();
  });

  it('assigns bye cleanly to the lowest-ranked eligible bot when bot count is odd', () => {
    const standings: StandingEntry[] = [
      { botId: 'bot_1', botName: 'Bot 1', language: 'TS', matchesPlayed: 0, wins: 0, losses: 0, draws: 0, points: 0, elo: 1400 },
      { botId: 'bot_2', botName: 'Bot 2', language: 'TS', matchesPlayed: 0, wins: 0, losses: 0, draws: 0, points: 0, elo: 1300 },
      { botId: 'bot_3', botName: 'Bot 3', language: 'TS', matchesPlayed: 0, wins: 0, losses: 0, draws: 0, points: 0, elo: 1200 },
    ];

    const result = generateSwissPairings(standings, new Set<string>(), new Set<string>());
    expect(result.pairings.length).toBe(1);
    expect(result.byeBotId).toBe('bot_3'); // Lowest-ranked bot gets the bye
  });
});

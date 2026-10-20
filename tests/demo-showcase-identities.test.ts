import { describe, expect, it } from 'vitest';
import { buildShowcaseCourses, buildShowcaseIdentities } from '../deploy/linux/demo-showcase-identities.js';

describe('showcase identity plan', () => {
  it('creates three course cohorts and two uniquely named students per team', () => {
    const courses = buildShowcaseCourses('SHOWCASE');
    const users = buildShowcaseIdentities('SHOWCASE');
    expect(courses.map(({ code }) => code)).toEqual(['SHOWCASE_C1', 'SHOWCASE_C2', 'SHOWCASE_C3']);
    expect(new Set(courses.map(({ code }) => code)).size).toBe(3);
    expect(users).toHaveLength(96);
    expect(new Set(users.map(({ username }) => username)).size).toBe(96);
    expect(users.every(({ username, displayName, teamSlot }) => username.length <= 50 && displayName.length <= 50 && teamSlot >= 0 && teamSlot < 48)).toBe(true);
    for (let slot = 0; slot < 48; slot++) {
      expect(users.filter((user) => user.teamSlot === slot).map(({ role }) => role)).toEqual(['CAPTAIN', 'MEMBER']);
    }
  });
  it('uppercases generated course codes for the course API contract', () => {
    expect(buildShowcaseCourses('rating2026').map(({ code }) => code)).toEqual(['RATING2026_C1', 'RATING2026_C2', 'RATING2026_C3']);
  });

  it('keeps generated usernames inside the product limit at the maximum tag size', () => {
    expect(Math.max(...buildShowcaseIdentities('x'.repeat(27)).map(({ username }) => username.length))).toBeLessThanOrEqual(50);
  });
});

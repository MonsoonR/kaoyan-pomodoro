import { describe, expect, it } from 'vitest';
import { getExamCountdown } from './exam-date';

describe('exam countdown', () => {
  it('uses local calendar days instead of elapsed hours', () => {
    expect(getExamCountdown(
      new Date(2026, 6, 17, 23, 59),
      '2026-07-19',
    )).toEqual({ days: 2, status: 'upcoming' });
  });

  it('never exposes a negative day count after the exam date', () => {
    expect(getExamCountdown(
      new Date(2026, 6, 20, 8, 0),
      '2026-07-19',
    )).toEqual({ days: 0, status: 'past' });
  });

  it('has an explicit state on the exam date', () => {
    expect(getExamCountdown(
      new Date(2026, 6, 19, 8, 0),
      '2026-07-19',
    )).toEqual({ days: 0, status: 'today' });
  });
});

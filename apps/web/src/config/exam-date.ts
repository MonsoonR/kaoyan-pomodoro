export const EXAM_DATE = '2026-12-19';

export type ExamCountdown = {
  days: number;
  status: 'upcoming' | 'today' | 'past';
};

function localDateParts(value: Date): [number, number, number] {
  return [value.getFullYear(), value.getMonth(), value.getDate()];
}

function parseLocalDate(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid local date: ${value}`);
  return [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
}

export function getExamCountdown(
  now = new Date(),
  examDate = EXAM_DATE,
): ExamCountdown {
  const [currentYear, currentMonth, currentDay] = localDateParts(now);
  const [examYear, examMonth, examDay] = parseLocalDate(examDate);
  const difference = Math.round((
    Date.UTC(examYear, examMonth, examDay) -
    Date.UTC(currentYear, currentMonth, currentDay)
  ) / 86_400_000);

  if (difference > 0) return { days: difference, status: 'upcoming' };
  if (difference === 0) return { days: 0, status: 'today' };
  return { days: 0, status: 'past' };
}

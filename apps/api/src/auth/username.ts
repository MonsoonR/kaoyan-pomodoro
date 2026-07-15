export function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLowerCase();
}

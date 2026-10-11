/** XP required to have reached a level. Level 0 starts at 0 XP. */
export function xpForLevel(level) {
  const safeLevel = Math.max(0, Math.floor(Number(level) || 0));
  return Math.floor(100 * safeLevel + (25 * safeLevel * (safeLevel - 1)) / 2);
}

export function getLevel(totalXp) {
  const xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  // Invert xpForLevel(n) = 12.5n² + 87.5n, then correct for integer rounding.
  let level = Math.floor((-87.5 + Math.sqrt(87.5 * 87.5 + 50 * xp)) / 25);
  level = Math.max(0, level);
  while (xpForLevel(level + 1) <= xp) level++;
  while (level > 0 && xpForLevel(level) > xp) level--;
  return level;
}

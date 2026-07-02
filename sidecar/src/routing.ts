import type { TargetEntry } from './config.js';

// Longest-prefix match of the incoming To number against the target keys (spec §4).
export function matchTarget(to: string, targets: TargetEntry[]): TargetEntry | undefined {
  let best: TargetEntry | undefined;
  for (const t of targets) {
    if (to.startsWith(t.prefix) && (!best || t.prefix.length > best.prefix.length)) best = t;
  }
  return best;
}

// Drop the leading '+', remove the first stripDigits digits, prepend '+'.
// Returns null when stripping leaves nothing to dial.
export function resolveTarget(to: string, entry: TargetEntry): string | null {
  const rest = to.slice(1 + entry.stripDigits);
  return rest.length > 0 ? `+${rest}` : null;
}

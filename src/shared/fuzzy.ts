/**
 * Fuzzy all-token matcher for the Ctrl+F find lens (shared so renderer views —
 * and any future main-process consumers — agree on semantics).
 *
 * Query semantics: tokenize on whitespace; a haystack matches only if EVERY
 * token matches (AND). Per token, two chances:
 *   1. case-insensitive substring over `title + ' ' + tags.join(' ') + ' ' + type`
 *   2. failing that, in-order character subsequence of the title
 *      (so `gcv` hits "Graph Canvas view")
 * An empty / whitespace-only query applies no filter (matches everything).
 */

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** True when every char of `needle` appears in `hay` in order (not necessarily adjacent). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

export function matchesAllTokens(
  query: string,
  haystack: { title: string; tags: string[]; type: string }
): boolean {
  const tokens = tokenize(query)
  if (tokens.length === 0) return true
  const title = haystack.title.toLowerCase()
  const full = `${title} ${haystack.tags.join(' ').toLowerCase()} ${haystack.type.toLowerCase()}`
  return tokens.every((tok) => full.includes(tok) || isSubsequence(tok, title))
}

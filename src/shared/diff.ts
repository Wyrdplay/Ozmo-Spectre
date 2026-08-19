// Hand-rolled line-level unified diff. Pure — no imports, safe for main and renderer.
//
// unifiedDiff(a, b) returns standard unified-format hunks ("@@ -l,c +l,c @@" plus
// ' '/'-'/'+' lines) with `context` lines of context, or '' when nothing changed.
// LCS-based: common prefix/suffix are trimmed first, then a dynamic-programming
// LCS aligns the middle. Guards: bodies over MAX_LINES lines on either side (or a
// middle too large to align affordably) degrade to a single replace hunk rather
// than burning memory — the diff is coarser but still valid unified format.

const MAX_LINES = 8000
/** DP cell budget for the trimmed middle (~64MB transient at 4 bytes/cell). */
const MAX_LCS_CELLS = 16_000_000

/** -1 = line removed from a, 1 = line added from b, 0 = unchanged. */
interface Op {
  t: -1 | 0 | 1
  /** 0-based position in a at the moment this op applies */
  ai: number
  /** 0-based position in b at the moment this op applies */
  bi: number
  line: string
}

/** Split into logical lines; a trailing newline does not create a phantom empty line. */
function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** All-delete-then-all-insert ops covering a[aFrom..] × b[bFrom..] — the coarse fallback. */
function replaceOps(a: string[], b: string[], aFrom: number, bFrom: number): Op[] {
  const ops: Op[] = []
  for (let i = 0; i < a.length; i++) ops.push({ t: -1, ai: aFrom + i, bi: bFrom, line: a[i] })
  for (let j = 0; j < b.length; j++) ops.push({ t: 1, ai: aFrom + a.length, bi: bFrom + j, line: b[j] })
  return ops
}

/** Minimal edit script for a×b via LCS dynamic programming. Positions offset by aFrom/bFrom. */
function lcsOps(a: string[], b: string[], aFrom: number, bFrom: number): Op[] {
  const n = a.length
  const m = b.length
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) return replaceOps(a, b, aFrom, bFrom)
  const w = m + 1
  // dp[i*w+j] = LCS length of a[i..] vs b[j..]
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w
    const below = (i + 1) * w
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[below + j + 1] + 1 : Math.max(dp[below + j], dp[row + j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 0, ai: aFrom + i, bi: bFrom + j, line: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: -1, ai: aFrom + i, bi: bFrom + j, line: a[i] })
      i++
    } else {
      ops.push({ t: 1, ai: aFrom + i, bi: bFrom + j, line: b[j] })
      j++
    }
  }
  for (; i < n; i++) ops.push({ t: -1, ai: aFrom + i, bi: bFrom + j, line: a[i] })
  for (; j < m; j++) ops.push({ t: 1, ai: aFrom + i, bi: bFrom + j, line: b[j] })
  return ops
}

/** Render grouped hunks from a full-file op sequence. */
function renderHunks(ops: Op[], context: number): string {
  // group change runs that sit within 2*context of each other, padded by context
  const groups: Array<{ start: number; end: number }> = []
  let gStart = -1
  let lastChange = -1
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].t === 0) continue
    if (gStart === -1) {
      gStart = Math.max(0, idx - context)
    } else if (idx - lastChange - 1 > 2 * context) {
      groups.push({ start: gStart, end: Math.min(ops.length, lastChange + 1 + context) })
      gStart = Math.max(0, idx - context)
    }
    lastChange = idx
  }
  if (gStart === -1) return ''
  groups.push({ start: gStart, end: Math.min(ops.length, lastChange + 1 + context) })

  const out: string[] = []
  for (const g of groups) {
    const slice = ops.slice(g.start, g.end)
    const aCount = slice.filter((o) => o.t !== 1).length
    const bCount = slice.filter((o) => o.t !== -1).length
    const aStart = aCount ? slice[0].ai + 1 : slice[0].ai
    const bStart = bCount ? slice[0].bi + 1 : slice[0].bi
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    // emit, normalising each change run to deletions-first
    let k = 0
    while (k < slice.length) {
      const op = slice[k]
      if (op.t === 0) {
        out.push(' ' + op.line)
        k++
        continue
      }
      const dels: string[] = []
      const inss: string[] = []
      while (k < slice.length && slice[k].t !== 0) {
        if (slice[k].t === -1) dels.push('-' + slice[k].line)
        else inss.push('+' + slice[k].line)
        k++
      }
      out.push(...dels, ...inss)
    }
  }
  return out.join('\n')
}

/**
 * Line-level unified diff of a → b. Returns '' when the line content is identical
 * (a trailing-newline-only difference counts as identical).
 */
export function unifiedDiff(a: string, b: string, context = 3): string {
  if (a === b) return ''
  const al = splitLines(a)
  const bl = splitLines(b)

  // oversize guard: one whole-file replace hunk, no alignment attempted
  if (al.length > MAX_LINES || bl.length > MAX_LINES) {
    return renderHunks(replaceOps(al, bl, 0, 0), context)
  }

  // trim common prefix/suffix, align only the middle
  let pre = 0
  while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++
  let suf = 0
  while (suf < al.length - pre && suf < bl.length - pre && al[al.length - 1 - suf] === bl[bl.length - 1 - suf]) suf++
  const am = al.slice(pre, al.length - suf)
  const bm = bl.slice(pre, bl.length - suf)
  if (am.length === 0 && bm.length === 0) return ''

  const ops: Op[] = []
  for (let k = 0; k < pre; k++) ops.push({ t: 0, ai: k, bi: k, line: al[k] })
  ops.push(...lcsOps(am, bm, pre, pre))
  for (let k = 0; k < suf; k++) {
    ops.push({ t: 0, ai: al.length - suf + k, bi: bl.length - suf + k, line: al[al.length - suf + k] })
  }
  return renderHunks(ops, context)
}

/**
 * Parser for Pokémon TCG tournament export (.tdf) XML from Tournament Operations.
 * See sample files: r0-start (roster), rN-begin (pairings), rN-end (results), *_end (full).
 */

export type TdfPlayer = {
  popId: string
  firstName: string
  lastName: string
}

export type TdfMatch = {
  roundNumber: number
  player1PopId: string
  player2PopId: string
  /** 0 = unplayed, 1 = player1 wins, 2 = player2 wins, 3 = draw */
  outcome: number
}

export type TdfStanding = {
  popId: string
  place: number
}

export type TdfFileKind = 'start' | 'begin' | 'end' | 'final'

export type ParsedTdf = {
  tournamentName: string | null
  players: TdfPlayer[]
  matches: TdfMatch[]
  standings: TdfStanding[]
}

export type TdfFileHint = {
  kind: TdfFileKind
  /** Target round from filename (rN-begin / rN-end); omitted for start/final */
  roundNumber?: number
}

/** Infer import mode from filename (e.g. `..._r1-end.tdf`). */
export function hintFromFileName(fileName: string): TdfFileHint {
  const base = fileName.replace(/^.*[/\\]/, '').toLowerCase()
  if (/r0[-_]?start/.test(base)) return { kind: 'start' }
  const begin = base.match(/r(\d+)[-_]begin/)
  if (begin) return { kind: 'begin', roundNumber: Number(begin[1]) }
  const endRound = base.match(/r(\d+)[-_]end/)
  if (endRound) return { kind: 'end', roundNumber: Number(endRound[1]) }
  if (/_end\.tdf$/.test(base) || base.endsWith('_end.tdf')) return { kind: 'final' }
  return { kind: 'final' }
}

function allPlayerTags(xml: string): TdfPlayer[] {
  const re = /<player\s+userid="(\d+)"[^>]*>[\s\S]*?<firstname>([^<]*)<\/firstname>[\s\S]*?<lastname>([^<]*)<\/lastname>/gi
  const out: TdfPlayer[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const popId = m[1]
    if (seen.has(popId)) continue
    seen.add(popId)
    out.push({
      popId,
      firstName: m[2].trim(),
      lastName: m[3].trim(),
    })
  }
  return out
}

function matchesInRoundBlock(roundXml: string, roundNumber: number): TdfMatch[] {
  const out: TdfMatch[] = []
  const re =
    /<match\s+outcome="(\d+)"[^>]*>[\s\S]*?<player1\s+userid="(\d+)"[^/]*\/>[\s\S]*?<player2\s+userid="(\d+)"[^/]*\/>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(roundXml)) !== null) {
    out.push({
      roundNumber,
      player1PopId: m[2],
      player2PopId: m[3],
      outcome: Number(m[1]),
    })
  }
  return out
}

function allMatches(xml: string): TdfMatch[] {
  const out: TdfMatch[] = []
  const roundRe = /<round\s+number="(\d+)"[^>]*>([\s\S]*?)<\/round>/gi
  let rm: RegExpExecArray | null
  while ((rm = roundRe.exec(xml)) !== null) {
    const roundNumber = Number(rm[1])
    out.push(...matchesInRoundBlock(rm[2], roundNumber))
  }
  return out
}

function allStandings(xml: string): TdfStanding[] {
  const out: TdfStanding[] = []
  const re = /<player\s+id="(\d+)"\s+place="(\d+)"\s*\/>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    out.push({ popId: m[1], place: Number(m[2]) })
  }
  return out
}

export function parseTdfXml(xml: string): ParsedTdf {
  const nameMatch = /<name>([^<]*)<\/name>/i.exec(xml)
  const players = allPlayerTags(xml)
  const matches = allMatches(xml)
  const standings = allStandings(xml)
  return {
    tournamentName: nameMatch?.[1]?.trim() || null,
    players,
    matches,
    standings,
  }
}

/** Matches for a single round (used for rN-begin / rN-end uploads). */
export function matchesForRound(parsed: ParsedTdf, roundNumber: number): TdfMatch[] {
  return parsed.matches.filter((m) => m.roundNumber === roundNumber)
}

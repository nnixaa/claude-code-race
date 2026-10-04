// Code race: type a line of code faster than the others.
//
// The server matches up to four people into a race and fills the empty seats with bots.
// Friends can have a room of their own instead: /race friend makes one under a code, the
// others join with /race join <code>, and the race starts when one of them presses Start.
// The band above the prompt shows the track and, under it, the line, opening a little at
// a time. You type in Claude's own message box: what matches the line moves you on, a
// mistake turns red there until you delete it, and Enter sends nothing while a race runs.
// Whatever was in the box before the race is put back after it.
//
// Once a second the mod sends your position and gets everyone's back. The track is a
// plain picture, drawn again on each answer, each key, and each change of phase: a
// surface reloads an interactive picture on every redraw, and a plain one runs no
// animation, so the racers move in steps of a second. Without the server the race is
// against bots alone.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptDecoration, Register, RenderElement, RenderSurface } from 'claude-code'

import type { Race, Racer } from '../types'

const SERVER = 'https://code-race.agentloom-app.workers.dev'
const race = atom({ plugin: 'code-race', key: 'race' } as const, null as Race | null)

const SEATS = 4
const COUNTDOWN_MS = 3000
const GO_MS = 700
const GRACE_MS = 5000 // once everyone else is in, how long you have left
const MAX_RACE_MS = 180_000 // a race is over this long after GO, as on the server
const JOIN_TIMEOUT_MS = 8000 // no answer from the server by then: race bots instead
const POLL_MS = 1000
const SEGMENTS = 6
const BEHIND = 12 // typed characters still shown in the line
const AHEAD = 56 // characters shown ahead of where you are
const PLACE = ['1st', '2nd', '3rd', '4th']
const YOU = '#d97757'
const GREY = '#8a857c'

// Offline only: the line and the bots, made here.
const LINES = [
  'const active = users.filter(u => u.lastSeen > Date.now() - 7 * DAY).map(u => ({id: u.id, name: u.name.trim()})).sort((a, b) => a.name.localeCompare(b.name));',
  'for (const [key, value] of Object.entries(config)) {if (value === undefined) continue; params.set(key, String(value));} const query = params.toString();',
]
const BOT_NAMES = ['mira', 'devon', 'kenji', 'ola', 'sam', 'priya', 'lucas', 'noor', 'ivan', 'zoe']
const BOT_COLORS = ['#6a9bcc', '#788c5d', '#b0aea5']

function botOf(name: string, color: string, length: number): Racer {
  const wpm = 28 + Math.round(Math.random() * 27)
  const finishMs = Math.round((length / ((wpm * 5) / 60)) * 1000)
  const legs = Array.from({ length: SEGMENTS }, () => 1 / (0.6 + Math.random() * 0.8))
  const total = legs.reduce((a, b) => a + b, 0)
  let at = 0
  const marks = legs.map(l => (at += l / total))
  return { kind: 'bot', name, color, pos: 0, finishedAt: null, hasLeft: false, finishMs, marks }
}

// How far along a bot is, ms after the start: straight lines between its marks.
function shareAt(bot: Racer, ms: number): number {
  if (ms <= 0) return 0
  const t = ms / bot.finishMs
  if (t >= 1) return 1
  let prev = 0
  for (let i = 0; i < bot.marks.length; i++) {
    const mark = bot.marks[i]!
    if (t <= mark) return (i + (t - prev) / (mark - prev)) / SEGMENTS
    prev = mark
  }
  return 1
}

// --- you ---------------------------------------------------------------------------------

// The id lasts across sessions, so a leaderboard can count on it. The desktop app and the
// terminal share this machine's store, so the id says which of the two plays: each is a
// player of its own, the same one every session. A race keeps the id it joined with.
async function playerOf($: EngineInterface): Promise<{ id: string; name: string }> {
  let player = (await $.store.get('player')) as string | undefined
  if (typeof player !== 'string') {
    player = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8)).join('-')
    await $.store.set('player', player)
  }
  const [surface] = await $.session.surfaces()
  const name = ((await $.store.get('name')) as string | undefined) ?? `anon-${player.slice(0, 4)}`
  return { id: `${player}-${surface === 'desktop' ? 'desktop' : 'terminal'}`, name }
}

// --- the server ---------------------------------------------------------------------------

type HumanSeat = { kind: 'you' | 'human'; name: string; color: string; pos: number; finishedAt: number | null; left?: boolean }
type BotSeat = { kind: 'bot'; name: string; color: string; finishMs: number; marks: number[] }
type Snapshot = { roomId: string; party?: string | null; serverNow: number; code: string; formingUntil: number; startAt: number; racers: (HumanSeat | BotSeat)[] }
type Answer = Snapshot | { offline: string } | { refused: string }

async function call($: EngineInterface, path: string, body: unknown): Promise<Answer | null> {
  try {
    const res = await $.http.fetch(SERVER + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return JSON.parse(res.text) as Answer
  } catch {
    return null
  }
}

const colorOf = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : GREY)

// The race as an answer has it, on this machine's clock. The offset between the clocks is
// measured at the middle of each request and kept from the quickest one: a slow answer
// (the first join wakes the server) would put it off by up to a second, and the countdown
// would jump. The server's finish stands over yours, since it is what the race records;
// until it comes, yours shows.
function fromSnapshot(r: Race, s: Snapshot, sentAt: number, receivedAt: number): Race {
  const rtt = receivedAt - sentAt
  const isBetter = r.offset === null || rtt <= r.rtt
  const offset = isBetter ? s.serverNow - (sentAt + receivedAt) / 2 : r.offset!
  const local = (t: number | null) => (t === null ? null : t - offset)
  const racers: Racer[] = s.racers.flatMap((x): Racer[] => {
    if (x.kind === 'you') return []
    const color = colorOf(x.color)
    if (x.kind === 'bot') return [{ kind: 'bot', name: x.name, color, pos: 0, finishedAt: null, hasLeft: false, finishMs: x.finishMs, marks: x.marks }]
    return [{ kind: 'human', name: x.name, color, pos: x.pos, finishedAt: local(x.finishedAt), hasLeft: !!x.left, finishMs: 0, marks: [] }]
  })
  const yours = s.racers.find((x): x is HumanSeat => x.kind === 'you')
  const finishedAt = yours?.finishedAt != null ? local(yours.finishedAt) : r.finishedAt
  return {
    ...r,
    roomId: s.roomId,
    party: typeof s.party === 'string' ? s.party : null,
    code: s.code,
    formingUntil: s.formingUntil - offset,
    startAt: s.startAt - offset,
    racers,
    polledAt: receivedAt,
    offset,
    rtt: isBetter ? rtt : r.rtt,
    tick: r.tick + 1,
    finishedAt,
    pos: finishedAt !== null ? s.code.length : r.pos,
  }
}

// Bots alone, after a short search: the server could not be reached, or said no.
function offlineRace(r: Race, now: number, note: string): Race {
  const code = LINES[Math.floor(Math.random() * LINES.length)]!
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5)
  const racers = BOT_COLORS.map((c, i) => botOf(names[i]!, c, code.length))
  return { ...r, roomId: 'offline', code, formingUntil: now + 1500, startAt: now + 1500 + COUNTDOWN_MS, racers, note }
}

// `party`: 'new' makes a friends' room, a code joins one (or its next round); none races
// whoever comes.
async function startRace($: EngineInterface, party: string | null = null) {
  const now = await $.clock.now()
  await leaveRace($) // a race still running is left, its seat freed and your draft put back
  const me = await playerOf($)
  const id = now
  // Joining: drawn at once, filled in by the server's answer.
  await update($, race, () => ({
    id,
    me: me.name,
    playerId: me.id,
    roomId: null,
    party,
    code: '',
    formingUntil: now + JOIN_TIMEOUT_MS,
    startAt: now + JOIN_TIMEOUT_MS + COUNTDOWN_MS,
    racers: [],
    polledAt: now,
    offset: null,
    rtt: 1e9, // no answer yet: any first one is quicker
    pos: 0,
    wrong: 0,
    errors: 0,
    finishedAt: null,
    draft: null,
    isRestored: false,
    tick: 0,
    note: null,
  }))
  const path = party === null ? '/join' : party === 'new' ? '/party' : `/party/${party}/join`
  const answer = await call($, path, { player: me.id, name: me.name })
  const at = await $.clock.now()
  const cur = await read($, race)
  if (!cur || cur.id !== id || cur.roomId !== null) return
  // Friends get no bots in their place: a room that cannot be had is said so.
  if (party !== null && !(answer && 'roomId' in answer)) return void (await refuse($, answer && 'refused' in answer ? answer.refused : 'The race server did not answer.'))
  await update($, race, (cur): Race | null => {
    if (!cur || cur.id !== id || cur.roomId !== null) return cur
    if (answer && 'roomId' in answer) return fromSnapshot(cur, answer, now, at)
    return offlineRace(cur, at, answer && 'offline' in answer ? answer.offline : 'Server unreachable')
  })
}

// The leaderboard as text: the ten fastest races, one a player, and where you stand.
type Standing = { place: number; name: string; wpm: number; races: number; wins: number; isYou: boolean }
async function leaderboard($: EngineInterface): Promise<string> {
  const me = await playerOf($)
  let board: { top: Standing[]; you: Standing | null }
  try {
    const res = await $.http.fetch(SERVER + '/leaderboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ player: me.id }) })
    if (!res.ok) throw new Error(String(res.status))
    board = JSON.parse(res.text)
  } catch {
    return 'The race server did not answer.'
  }
  const line = (x: Standing) => `${x.place}. ${x.name} · ${x.wpm} wpm · ${x.races} race${x.races === 1 ? '' : 's'} · ${x.wins} win${x.wins === 1 ? '' : 's'}${x.isYou ? ' (you)' : ''}`
  const you = board.you ? `You: #${board.you.place} · best ${board.you.wpm} wpm` : 'You: no finished race yet'
  return ['Leaderboard, by the fastest race', ...board.top.map(line), you].join('\n')
}

async function refuse($: EngineInterface, why: string) {
  await update($, race, () => null)
  $.ui.toast(`Code race: ${why}`)
}

// Start, in a friends' room: the countdown begins for everyone at their next answer.
async function startParty($: EngineInterface) {
  const r = await read($, race)
  if (!isCurrent(r) || !r.party || !r.roomId) return
  const sentAt = await $.clock.now()
  const answer = await call($, `/rooms/${r.roomId}/start`, { player: r.playerId })
  if (!answer || !('roomId' in answer)) return
  const at = await $.clock.now()
  await update($, race, cur => (cur && cur.id === r.id ? fromSnapshot(cur, answer, sentAt, at) : cur))
}

async function poll($: EngineInterface) {
  const r = await read($, race)
  if (!isCurrent(r) || !r.roomId || r.roomId === 'offline') return
  const sentAt = await $.clock.now()
  // Marked first, so the ticker sends no second poll while this one runs.
  await update($, race, cur => (cur && cur.id === r.id ? { ...cur, polledAt: sentAt } : cur))
  const answer = await call($, `/rooms/${r.roomId}/progress`, { player: r.playerId, pos: r.pos, errors: r.errors })
  if (!answer || !('roomId' in answer)) return
  const at = await $.clock.now()
  await update($, race, cur => (cur && cur.id === r.id ? fromSnapshot(cur, answer, sentAt, at) : cur))
}

// Leaves the race on screen, if one runs: the server stops waiting for you, and whatever
// was in your message box before the race goes back there.
async function leaveRace($: EngineInterface) {
  const r = await read($, race)
  if (!isCurrent(r)) return
  const stage = phaseOf(r, await $.clock.now()).stage
  if (r.roomId && r.roomId !== 'offline' && stage !== 'done') void call($, `/rooms/${r.roomId}/leave`, { player: r.playerId })
  if (!r.isRestored && r.draft !== null) await $.prompt.fill({ text: r.draft, mode: 'replace' })
}

async function quitRace($: EngineInterface) {
  await leaveRace($)
  await update($, race, () => null)
}

// The session keeps a race across reloads of the mod, so one saved by an older version
// can come back in another shape; such a race is dropped.
const isCurrent = (r: Race | null): r is Race =>
  !!r &&
  typeof r.playerId === 'string' &&
  typeof r.isRestored === 'boolean' &&
  'offset' in r &&
  Array.isArray(r.racers) &&
  r.racers.every(x => typeof x.hasLeft === 'boolean' && Array.isArray(x.marks))

// --- where the race is -------------------------------------------------------------------

const finishOf = (r: Race, x: Racer) => (x.kind === 'bot' ? r.startAt + x.finishMs : x.finishedAt)

function phaseOf(r: Race, now: number) {
  // Those still racing: everyone but who quit or went quiet. When they are all in, you
  // get GRACE_MS more; and nobody's race runs past MAX_RACE_MS.
  const racing = r.racers.filter(x => !x.hasLeft)
  const othersIn = r.racers.length > 0 && racing.every(x => (finishOf(r, x) ?? Infinity) <= now)
  const ins = r.racers.map(x => finishOf(r, x) ?? Infinity).filter(t => t <= now)
  const lastIn = othersIn ? Math.max(r.startAt, ...ins) : Infinity
  const capAt = r.startAt + MAX_RACE_MS
  const endAt = Math.min(othersIn ? lastIn + GRACE_MS : Infinity, capAt)
  const isOut = r.finishedAt === null && now >= endAt
  const isStarted = r.roomId !== null && now >= r.formingUntil
  const stage = !isStarted ? 'joining' : now < r.startAt ? 'countdown' : r.finishedAt !== null || isOut ? 'done' : 'racing'
  const count = stage === 'countdown' ? Math.ceil((r.startAt - now) / 1000) : 0
  const showsGo = stage === 'racing' && now < r.startAt + GO_MS
  const graceLeft = stage === 'racing' && othersIn ? Math.ceil((endAt - now) / 1000) : null
  // A friends' room waits for Start, not for a clock.
  const waitLeft = stage === 'joining' && r.roomId && !r.party ? Math.max(0, Math.ceil((r.formingUntil - now) / 1000)) : null
  return { stage, count, showsGo, graceLeft, waitLeft, isOut, othersIn, endAt }
}

// Your place, from 1: one more than everyone who finished before you.
function placeOf(r: Race): number {
  const yours = r.finishedAt ?? Infinity
  return 1 + r.racers.filter(x => (finishOf(r, x) ?? Infinity) < yours).length
}

// How much of the line your message box matches, and how many of the box's characters
// that took. The box may rewrite what you type: a backslash before a character it reads as
// markdown, curly quotes, a dash for --, an ellipsis for ...; each counts as what you typed.
const SAME: Record<string, string> = { '“': '"', '”': '"', '‘': "'", '’': "'", '—': '--', '–': '--', '…': '...' }
function matchOf(code: string, text: string): { pos: number; used: number } {
  let i = 0
  let j = 0
  while (j < text.length && i < code.length) {
    const ch = text[j]!
    if (ch === code[i]) {
      i++
      j++
    } else if (ch === '\\' && code[i] !== '\\' && text[j + 1] === code[i]) {
      j++ // the box's escape, not a key you pressed
    } else if (SAME[ch] && code.startsWith(SAME[ch]!, i)) {
      i += SAME[ch]!.length
      j++
    } else break
  }
  return { pos: i, used: j }
}
const wpmOf = (chars: number, ms: number) => (ms > 500 ? Math.round(chars / 5 / (ms / 60_000)) : 0)
const placeWord = (place: number) => (place === 1 ? 'You won!' : `${PLACE[place - 1]} place`)

// --- the track ---------------------------------------------------------------------------

// Claude's mascot as pixel art: a body with two eyes, arms out, and four legs in one of
// two steps, so a racer seen at each redraw appears to run.
const CELL = 2.5
function mascot(color: string, step: 0 | 1): string {
  const r = (x: number, y: number, w: number, h: number, fill = color) =>
    `<rect x="${x * CELL}" y="${y * CELL}" width="${w * CELL}" height="${h * CELL}" fill="${fill}"/>`
  const legs = [2, 4, 6, 8].map((x, i) => r(x, 4, 1, (i + step) % 2 === 0 ? 2 : 1)).join('')
  return `${r(1, 0, 9, 4)}${r(0, 2, 11, 1)}${r(3, 1, 1, 1, '#1f1e1d')}${r(7, 1, 1, 1, '#1f1e1d')}${legs}`
}

// Drawn one to one for a band about 760 pixels wide; the surface scales it down when the
// band is narrower. Its height is given to the surface too, or the picture takes a default.
const W = 760
const LANE = 24
const TOP = 8 // room above the first lane for a crown
const NAME_W = 84
const FINISH = W - 44
const MASCOT_W = 11 * CELL
const trackX = (share: number) => NAME_W + share * (FINISH - NAME_W - MASCOT_W)
const SANS = 'font-family="-apple-system,system-ui,sans-serif"'
const trackHeight = () => TOP + SEATS * LANE
const MEDALS = ['#e3b341', '#b8b5ad', '#c98b5b'] // gold, silver, bronze

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A medal right of the finish line for places 1 to 3, the place in words after that.
function medal(y: number, place: number, isYou: boolean): string {
  if (place > 3) return `<text x="${FINISH + 9}" y="${y + 13}" ${SANS} font-size="12" fill="${GREY}" font-weight="${isYou ? 700 : 400}">${PLACE[place - 1]}</text>`
  const cx = FINISH + 18
  const cy = y + 9
  const ribbon = `<path d="M${cx - 5} ${cy - 10} L${cx - 2} ${cy - 3} L${cx + 2} ${cy - 3} L${cx + 5} ${cy - 10} Z" fill="${YOU}" opacity=".8"/>`
  const disc = `<circle cx="${cx}" cy="${cy + 1}" r="7" fill="${MEDALS[place - 1]}"/>`
  const digit = `<text x="${cx}" y="${cy + 4.5}" text-anchor="middle" ${SANS} font-size="9" font-weight="800" fill="#1f1e1d">${place}</text>`
  return ribbon + disc + digit
}

// A pixel crown on the winner's head.
function crown(x: number, y: number): string {
  const r = (dx: number, dy: number, w: number, h: number) => `<rect x="${x + dx}" y="${y + dy}" width="${w}" height="${h}" fill="${MEDALS[0]}"/>`
  return r(5, -4, 17, 3) + r(5, -8, 3, 4) + r(12, -9, 3, 5) + r(19, -8, 3, 4)
}

// A burst of confetti around the banner when you won, laid out the same way each time:
// pieces on a golden-angle spiral, wide rather than tall to fit the track.
function confetti(h: number): string {
  const colors = [YOU, '#6a9bcc', '#788c5d', MEDALS[0], '#c98bb9']
  const cx = (NAME_W + FINISH) / 2
  const cy = h / 2
  return Array.from({ length: 48 }, (_, i) => {
    const angle = i * 2.39996
    const reach = 0.45 + ((i * 37) % 55) / 100
    const x = Math.round(cx + Math.cos(angle) * reach * 300)
    const y = Math.round(Math.min(h - 6, Math.max(2, cy + Math.sin(angle) * reach * (h / 2 + 6))))
    const turn = (i * 47) % 180
    const [w, l] = i % 3 === 0 ? [4, 4] : [3, 7]
    return `<rect x="${x}" y="${y}" width="${w}" height="${l}" rx="1" fill="${colors[i % colors.length]}" transform="rotate(${turn} ${x} ${y})"/>`
  }).join('')
}

// The whole track in one picture: a lane each, the finish line, medals and a crown once
// the race is over for you, and over it the wait, the countdown, GO, or your result.
function trackSvg(r: Race, now: number): string {
  const p = phaseOf(r, now)
  const elapsed = Math.max(0, now - r.startAt)
  const isRunning = p.stage === 'racing' || p.stage === 'done'
  const step = (r.tick % 2) as 0 | 1 // a step per redraw
  const parts: string[] = [`<clipPath id="names"><rect x="0" y="0" width="${NAME_W - 6}" height="${trackHeight()}"/></clipPath>`]

  // Places among those already in.
  const order = [...r.racers.map(x => finishOf(r, x) ?? Infinity), r.finishedAt ?? Infinity].filter(t => t <= now).sort((a, b) => a - b)
  const placeAt = (t: number | null) => (t === null || t > now ? null : order.indexOf(t) + 1)
  const marks = (y: number, place: number | null, isYou: boolean, x: number) => {
    if (p.stage !== 'done' || place === null) return
    parts.push(medal(y, place, isYou))
    if (place === 1) parts.push(crown(x, y))
  }
  const lane = (i: number, name: string, isYou: boolean) => {
    const y = TOP + i * LANE
    if (isYou) parts.push(`<rect x="0" y="${y}" width="${W}" height="${LANE}" rx="6" fill="${YOU}" opacity=".12"/>`)
    const weight = isYou ? 700 : 400
    parts.push(`<text x="8" y="${y + 16}" ${SANS} font-size="13" fill="${isYou ? YOU : GREY}" font-weight="${weight}" clip-path="url(#names)">${escape(name.slice(0, 16))}</text>`)
    parts.push(`<line x1="${NAME_W}" y1="${y + 19.5}" x2="${FINISH}" y2="${y + 19.5}" stroke="#c9c3b6" stroke-dasharray="2 5"/>`)
    parts.push(`<rect x="${FINISH}" y="${y + 2}" width="2" height="19" fill="${GREY}"/>`)
    return y + 4
  }

  // You, stepping with each character you type.
  const yy = lane(0, r.me, true)
  const youX = trackX(r.code ? r.pos / r.code.length : 0)
  parts.push(`<g transform="translate(${youX} ${yy})">${mascot(YOU, (r.pos % 2) as 0 | 1)}</g>`)
  marks(yy, placeAt(r.finishedAt), true, youX)
  if (p.isOut) parts.push(`<text x="${FINISH + 9}" y="${yy + 13}" ${SANS} font-size="12" font-weight="700" fill="${GREY}">DNF</text>`)

  // The others, where the last answer (a human) or their marks (a bot) put them.
  r.racers.forEach((o, k) => {
    const y = lane(k + 1, o.name, false)
    const fin = finishOf(r, o)
    const share = o.kind === 'human' ? (r.code ? o.pos / r.code.length : 0) : isRunning ? shareAt(o, elapsed) : 0
    const isMoving = isRunning && (fin === null || fin > now) && !o.hasLeft
    const x = trackX(share)
    parts.push(`<g transform="translate(${x} ${y})" opacity="${o.hasLeft ? 0.4 : 1}">${mascot(o.color, isMoving ? step : 0)}</g>`)
    marks(y, placeAt(fin), false, x)
  })
  // Seats nobody has taken yet, until the bots take them; friends race without.
  if (p.stage === 'joining' || (p.stage === 'countdown' && !r.party)) {
    for (let i = r.racers.length + 1; i < SEATS; i++) {
      const y = TOP + i * LANE
      parts.push(`<text x="8" y="${y + 16}" ${SANS} font-size="13" fill="#c9c3b6">…</text>`)
      parts.push(`<line x1="${NAME_W}" y1="${y + 19.5}" x2="${FINISH}" y2="${y + 19.5}" stroke="#e3dfd5" stroke-dasharray="2 5"/>`)
    }
  }

  const h = trackHeight()
  const mid = (NAME_W + FINISH) / 2
  const banner = (text: string, size: number) => {
    parts.push(`<rect x="${mid - 100}" y="${h / 2 - 22}" width="200" height="44" rx="10" fill="#faf9f5" opacity=".88"/>`)
    parts.push(`<text x="${mid}" y="${h / 2 + size * 0.35}" text-anchor="middle" ${SANS} font-size="${size}" font-weight="800" fill="${YOU}">${text}</text>`)
  }
  const isWin = p.stage === 'done' && !p.isOut && placeOf(r) === 1
  if (isWin) parts.unshift(confetti(h))
  if (p.waitLeft !== null && p.waitLeft > 0) banner(`${p.waitLeft}s`, 26)
  if (p.stage === 'joining' && r.party && r.roomId) banner(escape(r.party), 26)
  if (p.stage === 'countdown') banner(String(p.count), 32)
  if (p.showsGo) banner('GO!', 32)
  if (p.isOut) banner('Race over', 24)
  else if (p.stage === 'done') banner(placeWord(placeOf(r)), 24)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" shape-rendering="crispEdges">${parts.join('')}</svg>`
}

// The line on the desktop, drawn as a picture in a monospace face, which the surface's
// text has none of: every character the same width, so the line never shifts unevenly. As
// in the terminal: what you typed dim, the next character on an orange ground, then what is
// ahead, opening as you go.
const MONO = 'font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"'
const LINE_FONT = 13
const CHAR_W = LINE_FONT * 0.6
const LINE_H = 22
function lineSvg(r: Race): string {
  const from = Math.max(0, r.pos - BEHIND)
  const typed = `${from > 0 ? '…' : ''}${r.code.slice(from, r.pos)}`
  const next = r.code[r.pos] ?? ''
  const room = Math.floor(W / CHAR_W) - typed.length - 2 // to the right edge, less the cursor and the …
  const ahead = r.code.slice(r.pos + 1, r.pos + 1 + room)
  const more = r.pos + 1 + room < r.code.length
  const at = (typed.length * CHAR_W).toFixed(1)
  const y = 15
  // Spaces as no-break spaces: a surface may fold a space at the edge of a text away.
  const keep = (t: string) => escape(t).replace(/ /g, '\u00a0')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${LINE_H}" width="${W}" height="${LINE_H}">` +
    '<style>.t{fill:#1f1e1d}.d{fill:#a29f96}@media (prefers-color-scheme:dark){.t{fill:#eceae4}.d{fill:#7d7a72}}</style>' +
    `<g ${MONO} font-size="${LINE_FONT}">` +
    // What you typed ends where you are, whatever the face's real width.
    `<text class="d" x="${at}" y="${y}" text-anchor="end">${keep(typed)}</text>` +
    `<rect x="${at}" y="3" width="${CHAR_W.toFixed(1)}" height="17" rx="2" fill="${r.wrong > 0 ? '#c4473a' : YOU}"/>` +
    `<text x="${at}" y="${y}" fill="#ffffff" font-weight="700">${keep(next)}</text>` +
    `<text class="t" x="${((typed.length + 1) * CHAR_W).toFixed(1)}" y="${y}">${keep(ahead)}${more ? '<tspan class="d">…</tspan>' : ''}</text>` +
    '</g></svg>'
  )
}

// --- the mod -----------------------------------------------------------------------------

// What the band shows changes with time alone at these moments; a redraw is asked for then.
const phaseKey = (r: Race, now: number) => {
  const p = phaseOf(r, now)
  return `${p.stage}:${p.count}:${p.showsGo}:${p.graceLeft}:${p.waitLeft}:${p.isOut}`
}
let lastKey = ''

const USAGE =
  'Usage: /race to race whoever comes, /race friend to make a room for friends, /race join <code> to join one, /race top for the leaderboard, /race nick <name> to race under a name (letters, digits, _ . -).'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Immediate: a race starts at once, also while Claude is still answering.
    await $.command.register({ name: 'race', description: 'Race others at typing a line of code', argumentHint: '[friend | join <code> | top | nick <name>]', immediate: true })
    if (!isCurrent(await read($, race))) await update($, race, () => null)
    $.clock.every(250, () => tick($))
    return next(e)
  })

  on('command.run', { command: 'race' }, async ($, e) => {
    const args = e.args.trim()
    if (/^(?:top|leaderboard|board|lb)$/i.test(args)) return { text: await leaderboard($) }
    if (/^(?:friend|friends|room|party)$/i.test(args)) {
      void startRace($, 'new')
      return { text: 'Making a room for friends…' }
    }
    const join = args.match(/^join\s+(\S+)$/i)?.[1]
    if (join) {
      if (!/^[a-z2-9]{5}$/i.test(join)) return { text: `${join} is not a room code: it has five letters and digits, like K7QMX.` }
      void startRace($, join.toUpperCase())
      return { text: `Joining room ${join.toUpperCase()}…` }
    }
    if (args) {
      const name = args.match(/^(?:nick|name)\s+(.+)$/)?.[1]
      const clean = name?.replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 16)
      if (!clean) return { text: USAGE }
      await $.store.set('name', clean)
    }
    void startRace($)
    return { text: `${args ? `You race as ${(await $.store.get('name')) as string}. ` : ''}Looking for racers…` }
  })

  // Your typing, in the message box: held back during the countdown, then checked against
  // the line after each edit.
  on('prompt.edit', async ($, e, next) => {
    const r = await read($, race)
    if (!isCurrent(r)) return next(e)
    const stage = phaseOf(r, await $.clock.now()).stage
    if (stage === 'countdown') return { text: e.text, cursor: e.cursor }
    if (stage !== 'racing') return next(e)
    if (!e.key && e.inputText.length > 8) return { text: e.text, cursor: e.cursor } // a paste is not typing
    const box = await next(e)
    const now = await $.clock.now()
    const { pos, used } = matchOf(r.code, box.text)
    const wrong = box.text.length - used
    const done = pos === r.code.length // whatever trails it in the box does not hold you back
    await update($, race, (cur): Race | null =>
      isCurrent(cur) && cur.id === r.id && cur.finishedAt === null
        ? { ...cur, pos, wrong, errors: cur.errors + (wrong > cur.wrong ? 1 : 0), finishedAt: done ? now : null, isRestored: done }
        : cur,
    )
    if (done) {
      void poll($) // the finish goes to the server at once
      const draft = r.draft ?? ''
      return { text: draft, cursor: draft.length }
    }
    // A red ground, not an underline: an underline hides an underscore and dresses up a space.
    const decorations: PromptDecoration[] = wrong > 0 ? [{ start: used, end: box.text.length, backgroundColor: 'error', color: '#ffffff' }] : []
    return { ...box, decorations: [...(box.decorations ?? []), ...decorations] }
  })

  // Your own Enter sends nothing to Claude while a race runs, so a half-typed line never
  // reaches it. Slash commands still go through, and prompts that are not yours (a task's
  // notice, a scheduled prompt) are left alone.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' || e.text.trimStart().startsWith('/')) return next(e)
    const r = await read($, race)
    if (isCurrent(r) && ['countdown', 'racing'].includes(phaseOf(r, await $.clock.now()).stage)) {
      // A held prompt still empties the box: what you typed goes straight back.
      $.clock.after(50, () => void $.prompt.fill({ text: e.text, mode: 'replace' }))
      return { drop: 'Enter is paused during a code race: finish the line or press Quit.' }
    }
    return next(e)
  })

  // While Claude works, a small Race button beside the spinner: the desktop holds a /race
  // typed then in its own queue until the turn ends, so this is the way in mid-turn.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return row
    const r = await read($, race)
    if (isCurrent(r) && phaseOf(r, await $.clock.now()).stage !== 'done') return row
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" columnGap={2} alignItems="center">
        {row}
        <Button key="race" label="Race" plain onPress={() => startRace($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    const r = await read($, race)
    if (!isCurrent(r)) return next(e)
    const now = await $.clock.now()
    const p = phaseOf(r, now)
    const { Box, Text, Button } = $.ui.resolve(e)
    const len = r.code.length
    const status = statusOf(r, p, now, e.surface === 'terminal')

    // The line, a window around where you are: what you typed dim, the next character on
    // an orange ground (an underline would hide an underscore), then what is ahead; the
    // rest opens as you go.
    const lineOf = (ahead: number) => {
      const from = Math.max(0, r.pos - BEHIND)
      const next_ = r.code[r.pos] === ' ' ? '␣' : (r.code[r.pos] ?? '')
      return (
        <Text>
          <Text dimColor>{`${from > 0 ? '…' : ''}${r.code.slice(from, r.pos)}`}</Text>
          <Text bold color="#ffffff" backgroundColor={r.wrong > 0 ? 'error' : YOU}>{next_}</Text>
          <Text>{r.code.slice(r.pos + 1, r.pos + 1 + ahead)}</Text>
          <Text dimColor>{r.pos + 1 + ahead < len ? '…' : ''}</Text>
        </Text>
      )
    }

    const isDone = p.stage === 'done'
    const isWaiting = p.stage === 'joining' && !!r.party && !!r.roomId // a friends' room, filling up
    const quit = <Button key="quit" label="Quit" onPress={() => quitRace($)} />
    const invite = `/race join ${r.party}`
    const copy = async (surface: RenderSurface) => {
      const { isCopied } = await $.ui.copy({ text: invite, surface })
      $.ui.toast(isCopied ? `Copied: ${invite}` : `Send your friends: ${invite}`)
    }
    const header = (
      <Box flexDirection="row" columnGap={2} alignItems="center">
        <Text bold>Code race</Text>
        <Text dimColor>{status}</Text>
        {isWaiting && <Button key="start" label="Start" variant="primary" onPress={() => startParty($)} />}
        {isWaiting && <Button key="copy" label="Copy invite" onPress={press => copy(press.surface)} />}
        {isDone && <Button key="again" label="Rerace" variant="primary" onPress={() => startRace($, r.party)} />}
        {isDone ? <Button key="quit" label="×" plain role="dismiss" onPress={() => quitRace($)} /> : quit}
      </Box>
    )

    // The terminal: the lanes, then one row right over the prompt: the line while the race
    // runs, the header otherwise. The band keeps its height from joining to the end.
    if (e.surface === 'terminal') {
      const ahead = Math.max(12, Math.min(AHEAD, e.props.bodyColumns - BEHIND - 14))
      return (
        <Box flexDirection="column" width="100%">
          {terminalTrack(r, p, now, e.props.bodyColumns, e.props.maxRows, Box, Text)}
          {p.stage === 'racing' ? (
            <Box flexDirection="row" columnGap={2}>
              {lineOf(ahead)}
              {quit}
            </Box>
          ) : (
            header
          )}
        </Box>
      )
    }

    // The desktop: a plain picture, not a frame: a frame reloads, and flashes, on every redraw.
    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" rowGap={1} width="100%">
        {header}
        <Svg source={trackSvg(r, now)} alt="Race track" height={trackHeight()} />
        {p.stage === 'racing' ? <Svg source={lineSvg(r)} alt={r.code} height={LINE_H} /> : null}
      </Box>
    )
  })
}

// A small Clawd for the terminal, one row high: the orange block of Claude Code's mascot with
// its black eyes, and arms that swing as it runs and go up over the line.
const EYES = '#000000'
const ARMS = { down: ['▗', '▖'], up: ['▝', '▘'], left: ['▝', '▖'], right: ['▗', '▘'] } as const
const ART_W = 8

function clawd(arms: keyof typeof ARMS, color: string) {
  return [
    { text: ARMS[arms][0], color },
    { text: ' ▪  ▪ ', color: EYES, bg: color },
    { text: ARMS[arms][1], color },
  ]
}

// The terminal's track: a row a racer, an empty row between them where the band has room.
// The room is judged once, for all four seats, so nothing moves as racers join.
function terminalTrack(r: Race, p: Phase, now: number, columns: number, maxRows: number, Box: any, Text: any): RenderElement {
  const len = r.code.length
  const elapsed = Math.max(0, now - r.startAt)
  const isRunning = p.stage === 'racing' || p.stage === 'done'
  const share = (o: Racer) => (o.kind === 'bot' ? (isRunning ? shareAt(o, elapsed) : 0) : len ? o.pos / len : 0)
  const order = [...r.racers.map(x => finishOf(r, x) ?? Infinity), r.finishedAt ?? Infinity].filter(t => t <= now).sort((a, b) => a - b)
  const placeAt = (t: number | null) => (t === null || t > now ? null : order.indexOf(t) + 1)
  const lanes = [
    { name: r.me, color: YOU, share: len ? r.pos / len : 0, isYou: true, moving: p.stage === 'racing', place: placeAt(r.finishedAt) },
    ...r.racers.map(o => {
      const fin = finishOf(r, o)
      return { name: o.name, color: o.color, share: share(o), isYou: false, moving: isRunning && (fin === null || fin > now) && !o.hasLeft, place: placeAt(fin) }
    }),
  ]
  const free = Math.max(1, (maxRows || 8) - 1) // less the row under the lanes
  const hasGaps = free >= SEATS * 2 - 1
  const width = Math.max(24, Math.min(64, columns - 20))
  const tag = (place: number | null) => (p.stage === 'done' && place !== null ? ` ${['🥇', '🥈', '🥉'][place - 1] ?? PLACE[place - 1]}` : '')
  const rows: RenderElement[] = []
  const shown = Math.max(1, Math.min(SEATS, free))
  lanes.slice(0, shown).forEach((l, i) => {
    // A step a redraw for the others, a step a key for you.
    const stride = l.isYou ? r.pos % 2 === 1 : r.tick % 2 === 0
    const arms = l.place !== null ? 'up' : !l.moving ? 'down' : stride ? 'left' : 'right'
    const at = Math.round(l.share * (width - ART_W))
    if (hasGaps && i > 0) rows.push(<Text key={`gap${i}`}> </Text>)
    rows.push(
      <Text key={`lane${i}`}>
        <Text color={l.isYou ? YOU : undefined} bold={l.isYou} dimColor={!l.isYou}>{l.name.slice(0, 10).padEnd(10)}</Text>
        <Text dimColor>{` ${'─'.repeat(at)}`}</Text>
        {clawd(arms, l.color).map((g, j) => (
          <Text key={j} color={g.color} backgroundColor={'bg' in g ? g.bg : undefined}>{g.text}</Text>
        ))}
        <Text dimColor>{`${'─'.repeat(width - ART_W - at)}│`}</Text>
        <Text bold={l.isYou}>{tag(l.place)}</Text>
      </Text>,
    )
  })
  // Seats nobody has taken yet keep their rows, so the band doesn't grow as racers join.
  for (let i = lanes.length; i < shown; i++) {
    if (hasGaps) rows.push(<Text key={`gap${i}`}> </Text>)
    rows.push(<Text key={`lane${i}`} dimColor>{`${'·'.padEnd(10)} ${'─'.repeat(width)}│`}</Text>)
  }
  return <Box flexDirection="column">{rows}</Box>
}

// One clock for the race, every 250 ms: the server asked once a second while it runs, a
// redraw at each change of phase, your draft taken out of the message box at the countdown
// and put back when the race is over for you.
async function tick($: EngineInterface) {
  const r = await read($, race)
  if (!isCurrent(r)) return
  const now = await $.clock.now()
  const p = phaseOf(r, now)

  // No answer from the server in time: race bots instead.
  if (r.roomId === null && now >= r.formingUntil) {
    if (r.party) return void (await refuse($, 'The race server did not answer.'))
    await update($, race, cur => (cur && cur.id === r.id && cur.roomId === null ? offlineRace(cur, now, 'Server unreachable') : cur))
    return
  }
  // The countdown: what you had written is kept aside, and the box cleared for the race.
  if (p.stage === 'countdown' && r.draft === null) {
    const { text } = await $.prompt.read()
    const kept = await update($, race, cur => (cur && cur.id === r.id && cur.draft === null ? { ...cur, draft: text } : cur))
    if (kept?.draft === text) await $.prompt.fill({ text: '', mode: 'replace' })
    return
  }
  // Over for you, finished or not: your draft goes back, once the box takes it.
  if (p.stage === 'done' && !r.isRestored) {
    const { isFilled } = await $.prompt.fill({ text: r.draft ?? '', mode: 'replace' })
    if (isFilled) await update($, race, cur => (cur && cur.id === r.id ? { ...cur, isRestored: true } : cur))
  }

  // Answers keep coming until everyone is in, so medals arrive as they finish.
  const isLive = p.stage !== 'done' || (!p.othersIn && now < r.startAt + MAX_RACE_MS)
  if (r.roomId && r.roomId !== 'offline' && isLive && now - r.polledAt >= POLL_MS) return void (await poll($))
  if (r.roomId === 'offline' && isLive && p.stage !== 'joining' && now - r.polledAt >= POLL_MS) {
    await update($, race, cur => (cur && cur.id === r.id ? { ...cur, polledAt: now, tick: cur.tick + 1 } : cur)) // offline: a redraw a second
    return
  }
  const key = phaseKey(r, now)
  if (key !== lastKey) {
    lastKey = key
    await update($, race, cur => (cur && cur.id === r.id ? { ...cur, tick: cur.tick + 1 } : cur))
  }
}

type Phase = ReturnType<typeof phaseOf>

function statusOf(r: Race, p: Phase, now: number, isTerminal: boolean): string {
  const humans = r.racers.filter(o => o.kind === 'human').length + 1
  const bots = r.racers.filter(o => o.kind === 'bot').length
  const who = `${humans} ${humans === 1 ? 'person' : 'people'}${bots ? `, ${bots} bot${bots === 1 ? '' : 's'}` : ''}`
  if (p.stage === 'joining') {
    if (r.party === 'new' && !r.roomId) return 'Making a room…'
    if (r.party && !r.roomId) return `Joining room ${r.party}…`
    if (r.party) return `Room ${r.party} · ${humans}/${SEATS} in · friends join with /race join ${r.party}`
    if (r.roomId === 'offline') return `${r.note ?? 'Offline'} · racing bots`
    return `Finding racers… ${humans}/${SEATS}${p.waitLeft !== null ? ` · ${p.waitLeft}s` : ''}`
  }
  if (p.stage === 'countdown') return `${isTerminal ? `${p.count}… ` : ''}Get ready · ${r.roomId === 'offline' ? (r.note ?? 'offline') : who}`
  if (p.stage === 'racing') return p.graceLeft !== null ? `Everyone else is in · ${p.graceLeft}s left` : 'Type the line in your message box'
  const accuracy = r.pos + r.errors > 0 ? Math.round((100 * r.pos) / (r.pos + r.errors)) : 100
  if (p.isOut) return `Race over · ${PLACE[placeOf(r) - 1]} place · ${wpmOf(r.pos, p.endAt - r.startAt)} wpm`
  const yourMs = (r.finishedAt ?? now) - r.startAt
  return `${placeWord(placeOf(r))} · ${wpmOf(r.code.length, yourMs)} wpm · ${accuracy}% accuracy`
}

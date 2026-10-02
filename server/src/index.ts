// Code race server: matches players into races of four and keeps each race's progress.
//
// The mod polls: it joins through the lobby, then posts its position about once a second
// and gets everyone's back in the same answer. Seats nobody took when the room closes are
// raced by bots, whose runs are decided by the server so every player sees the same ones.
// Every race someone typed in is written to the database once it is over: the text,
// everyone in it, bots included, and how each of them did. A player is a random id the
// mod made and a nickname.
import { DurableObject } from 'cloudflare:workers'

import { CODE, TEXTS } from './texts'

interface Env {
  LOBBY: DurableObjectNamespace<Lobby>
  ROOM: DurableObjectNamespace<Room>
  DB: D1Database
  JOIN_CAP_PER_DAY: string
  BOT_WPM_MIN: string
  BOT_WPM_MAX: string
}

const SEATS = 4
const FORM_MS = 10_000 // how long a room waits for players
const COUNTDOWN_MS = 3000 // 3, 2, 1
const MAX_CPS = 25 // faster than this (300 wpm) is not typing
const MAX_RACE_MS = 180_000 // a race is over this long after its start, whoever is left
const SETTLE_MS = 10_000 // after the last finish, before the race is written
const SAVE_EVERY_MS = 5000 // how often the room keeps a copy of itself while it runs
const QUIET_MS = 15_000 // a racer silent this long after the start is no longer waited for
const PER_ADDRESS_PER_DAY = 150 // races one address may join in a day
const SEGMENTS = 6
const COLORS = ['#6a9bcc', '#788c5d', '#b0aea5', '#c98bb9', '#e3b341']
const BOT_NAMES = ['mira', 'devon', 'kenji', 'ola', 'sam', 'priya', 'lucas', 'noor', 'ivan', 'zoe']

type Human = {
  id: string
  nick: string // as the player chose it
  name: string // as the race shows it: the nick, numbered when two share it
  color: string
  pos: number
  finishedAt: number | null
  lastAt: number
  errors: number | null
  leftAt: number | null // pressed Quit, or started another race
}
type Bot = { name: string; color: string; finishMs: number; marks: number[] }
type RaceState = {
  id: string
  code: string
  kind: 'code' | 'docs'
  createdAt: number
  formingUntil: number
  startAt: number
  humans: Human[]
  bots: Bot[]
  savedAt: number // the last copy kept in storage
  isWritten: boolean // in the database
}

// What a player gets back: the race as it stands, times on the server's clock.
export type Snapshot = {
  roomId: string
  serverNow: number
  code: string
  formingUntil: number
  startAt: number
  racers: Racer[]
}
export type Racer =
  | { kind: 'you' | 'human'; name: string; color: string; pos: number; finishedAt: number | null; left: boolean }
  | { kind: 'bot'; name: string; color: string; finishMs: number; marks: number[] }

const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!

function botOf(name: string, color: string, length: number, min: number, max: number): Bot {
  const wpm = min + Math.round(Math.random() * Math.max(0, max - min))
  const finishMs = Math.round((length / ((wpm * 5) / 60)) * 1000)
  const legs = Array.from({ length: SEGMENTS }, () => 1 / (0.6 + Math.random() * 0.8))
  const total = legs.reduce((a, b) => a + b, 0)
  let at = 0
  return { name, color, finishMs, marks: legs.map(l => (at += l / total)) }
}

const wpmOf = (chars: number, ms: number) => (ms > 0 ? Math.round((chars / 5 / (ms / 60_000)) * 10) / 10 : null)

// Hands out rooms: the one still forming while it has seats and time, else a new one.
// It also counts the day's joins, and past the cap answers that the game is offline. One
// address can use only so much of the day, so nobody can spend it for everyone; the
// addresses are counted in memory and never stored.
export class Lobby extends DurableObject<Env> {
  private forming: { id: string; until: number; players: Set<string> } | null = null
  private perAddress = { day: '', counts: new Map<string, number>() }

  async join(player: string, address: string): Promise<{ roomId: string; formingUntil: number } | { offline: string }> {
    const now = Date.now()
    const day = new Date(now).toISOString().slice(0, 10)
    if (this.perAddress.day !== day) this.perAddress = { day, counts: new Map() }
    const mine = (this.perAddress.counts.get(address) ?? 0) + 1
    if (mine > PER_ADDRESS_PER_DAY) return { offline: 'That is enough races from here for today.' }
    this.perAddress.counts.set(address, mine)
    const count = (await this.ctx.storage.get<{ day: string; n: number }>('joins')) ?? { day, n: 0 }
    const n = count.day === day ? count.n : 0
    if (n >= Number(this.env.JOIN_CAP_PER_DAY || 1000)) return { offline: 'The game is full for today.' }
    await this.ctx.storage.put('joins', { day, n: n + 1 })
    // A seat for each player, once: a double press of Race does not take two.
    if (!this.forming || this.forming.until - now < 1000 || (this.forming.players.size >= SEATS && !this.forming.players.has(player))) {
      this.forming = { id: crypto.randomUUID(), until: now + FORM_MS, players: new Set() }
    }
    this.forming.players.add(player)
    return { roomId: this.forming.id, formingUntil: this.forming.until }
  }
}

// One race: its text, its players, its bots, and the clock it runs on. It keeps a copy of
// itself in storage, so the write at the end survives the room being put to sleep, and an
// alarm makes sure that write happens even when everyone has gone.
export class Room extends DurableObject<Env> {
  private race: RaceState | null = null

  private async load(): Promise<RaceState | null> {
    if (!this.race) this.race = (await this.ctx.storage.get<RaceState>('race')) ?? null
    return this.race
  }

  private async keep(now: number, force = false) {
    const r = this.race
    if (!r || (!force && now - r.savedAt < SAVE_EVERY_MS)) return
    r.savedAt = now
    await this.ctx.storage.put('race', r)
  }

  async join(roomId: string, formingUntil: number, player: string, name: string): Promise<Snapshot | null> {
    const now = Date.now()
    let r = await this.load()
    if (!r) {
      const code = pick(TEXTS)
      const names = [...BOT_NAMES].sort(() => Math.random() - 0.5)
      r = this.race = {
        id: roomId,
        code,
        kind: CODE.includes(code) ? 'code' : 'docs',
        createdAt: now,
        formingUntil,
        startAt: formingUntil + COUNTDOWN_MS, // typing opens at GO
        humans: [],
        bots: names
          .slice(0, SEATS - 1)
          .map((n, i) => botOf(n, COLORS[i + 1]!, code.length, Number(this.env.BOT_WPM_MIN || 28), Number(this.env.BOT_WPM_MAX || 55))),
        savedAt: 0,
        isWritten: false,
      }
      await this.ctx.storage.setAlarm(r.startAt + MAX_RACE_MS)
    }
    if (!r.humans.some(h => h.id === player)) {
      if (now >= r.formingUntil || r.humans.length >= SEATS) return null
      // Two people under one nickname are told apart.
      let shown = name
      for (let n = 2; r.humans.some(h => h.name === shown); n++) shown = `${name}${n}`
      r.humans.push({ id: player, nick: name, name: shown, color: COLORS[r.humans.length]!, pos: 0, finishedAt: null, lastAt: now, errors: null, leftAt: null })
      await this.keep(now, true)
    }
    return this.snapshot(player, now)
  }

  // Your position: kept if it could have been typed since GO at MAX_CPS, the finish
  // stamped on the server's clock. Your mistakes come as the mod counted them. Once the
  // race is over (written, or past its cap) nothing changes any more.
  async progress(player: string, pos: number, errors: number | null): Promise<Snapshot | null> {
    const now = Date.now()
    const r = await this.load()
    const you = r?.humans.find(h => h.id === player)
    if (!r || !you) return null
    const isOver = r.isWritten || now >= r.startAt + MAX_RACE_MS
    let finished = false
    if (!isOver && now >= r.startAt && you.finishedAt === null && Number.isInteger(pos)) {
      const allowed = Math.floor(((now - r.startAt) / 1000) * MAX_CPS) + 8
      you.pos = Math.max(you.pos, Math.min(pos, r.code.length, allowed))
      if (you.pos === r.code.length) {
        you.finishedAt = now
        finished = true
      }
    }
    if (!isOver && errors !== null && Number.isInteger(errors) && errors >= 0) you.errors = Math.min(errors, 10_000)
    you.lastAt = now
    if (!r.isWritten) await this.keep(now, finished)
    // Everyone in and every bot home: write the race soon rather than at the cap.
    if (finished && r.humans.every(h => h.finishedAt !== null)) {
      const botsHome = r.startAt + Math.max(0, ...this.seatedBots(r).map(b => b.finishMs))
      await this.ctx.storage.setAlarm(Math.max(now, botsHome) + SETTLE_MS)
    }
    return this.snapshot(player, now)
  }

  // You quit: the others stop waiting for you, and you get no place.
  async leave(player: string): Promise<boolean> {
    const r = await this.load()
    const you = r?.humans.find(h => h.id === player)
    if (!r || !you || r.isWritten) return false
    if (you.finishedAt === null && you.leftAt === null) {
      you.leftAt = Date.now()
      await this.keep(you.leftAt, true)
    }
    return true
  }

  async alarm() {
    const r = await this.load()
    if (!r || r.isWritten) return
    await this.write(r, Date.now())
    // Written: the room keeps nothing. A late poll gets "no such race", which the mod ignores.
    r.isWritten = true
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  // The bots in the seats nobody took, in the colors that follow the humans'.
  private seatedBots(r: RaceState): Bot[] {
    return r.bots.slice(0, SEATS - r.humans.length).map((b, i) => ({ ...b, color: COLORS[r.humans.length + i]! }))
  }

  // The race and everyone's result, bots included, in one batch.
  private async write(r: RaceState, now: number) {
    if (r.humans.every(h => h.pos === 0)) return // nobody typed: not a race worth keeping
    const bots = this.seatedBots(r)
    const runs = [
      ...r.humans.map((h, seat) => ({ seat, h, b: null as Bot | null, finishMs: h.finishedAt === null ? null : h.finishedAt - r.startAt, chars: h.pos })),
      ...bots.map((b, i) => ({ seat: r.humans.length + i, h: null as Human | null, b, finishMs: b.finishMs, chars: r.code.length })),
    ]
    const order = runs.filter(x => x.finishMs !== null).sort((a, b) => a.finishMs! - b.finishMs!)
    const db = this.env.DB
    const statements = [
      db.prepare('INSERT OR IGNORE INTO races (id, text, kind, created_at, start_at, ended_at, humans, bots) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(r.id, r.code, r.kind, r.createdAt, r.startAt, now, r.humans.length, bots.length),
      ...r.humans.map(h =>
        db
          .prepare('INSERT INTO players (id, name, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen WHERE excluded.last_seen > players.last_seen')
          .bind(h.id, h.nick, r.createdAt, h.lastAt),
      ),
      ...runs.map(x => {
        const place = x.finishMs === null ? null : order.indexOf(x) + 1
        // wpm only over a whole text: a few characters before leaving say nothing of speed.
        const wpm = x.finishMs === null ? null : wpmOf(x.chars, x.finishMs)
        const accuracy = x.h && x.h.errors !== null && x.chars + x.h.errors > 0 ? Math.round((1000 * x.chars) / (x.chars + x.h.errors)) / 10 : null
        return db
          .prepare('INSERT OR IGNORE INTO results (race_id, seat, player_id, name, is_bot, place, finish_ms, chars, wpm, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(r.id, x.seat, x.h?.id ?? null, x.h?.name ?? x.b!.name, x.b ? 1 : 0, place, x.finishMs, x.chars, wpm, accuracy)
      }),
    ]
    await db.batch(statements)
  }

  private snapshot(player: string, now: number): Snapshot {
    const r = this.race!
    const humans: Racer[] = r.humans.map(h => ({
      kind: h.id === player ? 'you' : 'human',
      name: h.name,
      color: h.id === player ? '#d97757' : h.color,
      pos: h.pos,
      finishedAt: h.finishedAt,
      // Quit, or silent too long since the start (closed Claude): nobody waits for them.
      left: h.leftAt !== null || (h.finishedAt === null && now > r.startAt && now - Math.max(h.lastAt, r.startAt) > QUIET_MS),
    }))
    // Bots take the seats left once the room has closed.
    const bots: Racer[] = now >= r.formingUntil ? this.seatedBots(r).map(b => ({ kind: 'bot', name: b.name, color: b.color, finishMs: b.finishMs, marks: b.marks })) : []
    return { roomId: r.id, serverNow: now, code: r.code, formingUntil: r.formingUntil, startAt: r.startAt, racers: [...humans, ...bots] }
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// A player id is the mod's own random string; a name is what the player chose, cleaned.
const PLAYER = /^[a-z0-9-]{8,48}$/
const nameOf = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 16) : '') || 'anon'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/') return new Response('code-race')
    if (request.method !== 'POST') return json({ error: 'not found' }, 404)
    // JSON only: a web page cannot send it without a preflight, which this server refuses.
    if (!request.headers.get('content-type')?.includes('application/json')) return json({ error: 'json only' }, 415)
    const body = (await request.json().catch(() => null)) as { player?: unknown; name?: unknown; pos?: unknown; errors?: unknown } | null
    const player = typeof body?.player === 'string' && PLAYER.test(body.player) ? body.player : null
    if (!player) return json({ error: 'bad player id' }, 400)

    if (url.pathname === '/join') {
      const name = nameOf(body?.name)
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('lobby'))
      // A room can close between the lobby's answer and the join: then ask once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        const seat = await lobby.join(player, request.headers.get('cf-connecting-ip') ?? 'unknown')
        if ('offline' in seat) return json(seat)
        const snapshot = await env.ROOM.get(env.ROOM.idFromName(seat.roomId)).join(seat.roomId, seat.formingUntil, player, name)
        if (snapshot) return json(snapshot)
      }
      return json({ offline: 'No room could be found.' })
    }

    const leaving = url.pathname.match(/^\/rooms\/([0-9a-f-]{36})\/leave$/)
    if (leaving) {
      const ok = await env.ROOM.get(env.ROOM.idFromName(leaving[1]!)).leave(player)
      return ok ? json({ ok }) : json({ error: 'no such race' }, 404)
    }

    const match = url.pathname.match(/^\/rooms\/([0-9a-f-]{36})\/progress$/)
    if (match) {
      const pos = typeof body?.pos === 'number' ? body.pos : -1
      const errors = typeof body?.errors === 'number' ? body.errors : null
      const snapshot = await env.ROOM.get(env.ROOM.idFromName(match[1]!)).progress(player, pos, errors)
      return snapshot ? json(snapshot) : json({ error: 'no such race' }, 404)
    }
    return json({ error: 'not found' }, 404)
  },
} satisfies ExportedHandler<Env>

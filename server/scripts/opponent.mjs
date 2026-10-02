// An opponent that waits in the lobby and races whoever comes: it keeps a room forming at
// all times, and races only when someone else has joined it.
// node scripts/opponent.mjs [name] [wpm] [minutes] [server]
const [name = 'claude', wpm = '55', minutes = '15', BASE = 'http://localhost:8787'] = process.argv.slice(2)
const post = async (path, body) => (await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const player = `${name}-${crypto.randomUUID().slice(0, 18)}`
const until = Date.now() + Number(minutes) * 60_000
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

while (Date.now() < until) {
  let s = await post('/join', { player, name })
  if (!s.roomId) { log('no room:', s); await sleep(5000); continue }
  // Wait for the room to close, watching who comes.
  while (s.serverNow < s.formingUntil - 300) {
    await sleep(1000)
    s = await post(`/rooms/${s.roomId}/progress`, { player, pos: 0 })
  }
  const others = s.racers.filter(r => r.kind === 'human')
  if (others.length === 0) continue // nobody came: open the next room
  log('racing', others.map(r => r.name).join(', '), '| text:', s.code.slice(0, 50))
  await sleep(Math.max(0, s.startAt - s.serverNow) + 400 + Math.random() * 500) // a human's reaction to GO
  const base = (Number(wpm) * 5) / 60
  let pos = 0, errors = 0, last = Date.now(), sent = 0
  while (pos < s.code.length) {
    await sleep(250)
    const now = Date.now()
    if (Math.random() < 0.05) { await sleep(400 + Math.random() * 900); last = Date.now(); continue } // a pause to think
    if (Math.random() < 0.04) errors++
    pos = Math.min(s.code.length, pos + base * (0.6 + Math.random() * 0.8) * ((now - last) / 1000))
    last = now
    if (now - sent >= 1000) { sent = now; s = await post(`/rooms/${s.roomId}/progress`, { player, pos: Math.floor(pos), errors }) }
  }
  s = await post(`/rooms/${s.roomId}/progress`, { player, pos: s.code.length, errors })
  const me = s.racers.find(r => r.kind === 'you')
  log('finished in', ((me.finishedAt - s.startAt) / 1000).toFixed(1), 's')
  await sleep(4000)
}
log('done')

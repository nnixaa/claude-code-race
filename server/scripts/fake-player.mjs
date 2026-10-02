// A second player for trying the mod: joins, then types at a steady speed.
// node scripts/fake-player.mjs [name] [wpm] [server]
const [name = 'friend', wpm = '45', BASE = 'http://localhost:8787'] = process.argv.slice(2)
const post = async (path, body) => (await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const player = crypto.randomUUID()
let s = await post('/join', { player, name })
if (!s.roomId) { console.log('no room:', s); process.exit(1) }
console.log(`${name} in room ${s.roomId.slice(0, 8)} with`, s.racers.map(r => r.name).join(', '))
await sleep(s.startAt - s.serverNow)
const cps = (Number(wpm) * 5) / 60
const t0 = Date.now()
while (true) {
  const pos = Math.min(s.code.length, Math.floor(((Date.now() - t0) / 1000) * cps))
  s = await post(`/rooms/${s.roomId}/progress`, { player, pos })
  const me = s.racers.find(r => r.kind === 'you')
  if (me.finishedAt) { console.log(`${name} finished in ${((me.finishedAt - s.startAt) / 1000).toFixed(1)}s`); break }
  await sleep(1000)
}

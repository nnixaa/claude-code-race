// Someone else in the race. Times are on this machine's clock: the server's are moved over
// by the offset measured at each answer.
export type Racer = {
  kind: 'human' | 'bot'
  name: string
  color: string
  pos: number // a human's position at the last answer
  finishedAt: number | null // a human's finish
  hasLeft: boolean // a human who quit or went quiet: nobody waits for them
  finishMs: number // a bot's finish, after the start
  marks: number[] // a bot's pace: when it reaches each sixth of the line, as shares of finishMs
}

export type Race = {
  id: number // when it was started, which tells one race from the next
  me: string // your nickname
  playerId: string // the id this race joined with, used for all its calls
  roomId: string | null // null while joining; 'offline' when racing bots alone
  code: string
  formingUntil: number // when the room closes and the countdown starts
  startAt: number // GO: typing opens
  racers: Racer[]
  polledAt: number
  offset: number | null // server clock minus this one, from the quickest answer so far
  rtt: number // how long that answer took
  pos: number // how much of the line your message box matches
  wrong: number // characters in your box past that, which you have to delete
  errors: number
  finishedAt: number | null
  draft: string | null // what was in your message box before the race, given back after
  isRestored: boolean // the message box has been given back
  tick: number // bumped on each answer and at each change of phase: a redraw, and a racer's next step
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'code-race': { race: Race | null }
  }
}

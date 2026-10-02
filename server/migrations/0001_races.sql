-- People who raced: the id is the mod's own random string, with the app it runs in.
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  first_seen INTEGER NOT NULL, -- ms since the epoch
  last_seen INTEGER NOT NULL
);

-- One row per race that started.
CREATE TABLE races (
  id TEXT PRIMARY KEY, -- the room id
  text TEXT NOT NULL,
  kind TEXT NOT NULL, -- code | docs
  created_at INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  humans INTEGER NOT NULL,
  bots INTEGER NOT NULL
);

-- Everyone in a race, bots included: where they got to and how fast.
CREATE TABLE results (
  race_id TEXT NOT NULL REFERENCES races(id),
  seat INTEGER NOT NULL,
  player_id TEXT REFERENCES players(id), -- null for a bot
  name TEXT NOT NULL,
  is_bot INTEGER NOT NULL,
  place INTEGER, -- null when they did not finish
  finish_ms INTEGER, -- after the start; null when they did not finish
  chars INTEGER NOT NULL, -- how much of the text they typed
  wpm REAL, -- over the race, from the server's clock
  accuracy REAL, -- as the player's mod reported it; null for a bot
  PRIMARY KEY (race_id, seat)
);

CREATE INDEX results_player ON results(player_id);
CREATE INDEX results_wpm ON results(wpm DESC) WHERE is_bot = 0 AND place IS NOT NULL;
CREATE INDEX races_start ON races(start_at);

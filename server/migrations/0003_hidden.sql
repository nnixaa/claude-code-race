-- Players kept out of the leaderboard (test scripts); their races stay.
ALTER TABLE players ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

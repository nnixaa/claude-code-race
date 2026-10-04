-- Who holds each name, so no two players race under one. The owner is the player id less
-- its -desktop or -terminal: the same machine's two apps share their name.
CREATE TABLE names (
  name TEXT PRIMARY KEY, -- lower case
  owner TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE INDEX names_owner ON names(owner);

-- The names already in use, each to whoever had it first; anon-… names are nobody's.
INSERT OR IGNORE INTO names (name, owner, claimed_at)
SELECT lower(name),
  CASE WHEN id LIKE '%-desktop' THEN substr(id, 1, length(id) - 8) WHEN id LIKE '%-terminal' THEN substr(id, 1, length(id) - 9) ELSE id END,
  first_seen
FROM players WHERE hidden = 0 AND name NOT LIKE 'anon%' ORDER BY first_seen;

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  time_zone TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE competitions (
  id TEXT PRIMARY KEY NOT NULL,
  creator_id TEXT NOT NULL REFERENCES profiles(user_id),
  opponent_id TEXT REFERENCES profiles(user_id),
  token_hash TEXT NOT NULL UNIQUE,
  create_request_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  expires_at INTEGER,
  UNIQUE (creator_id, create_request_id),
  CHECK (opponent_id IS NULL OR opponent_id != creator_id),
  CHECK ((opponent_id IS NULL AND accepted_at IS NULL AND expires_at IS NULL)
      OR (opponent_id IS NOT NULL AND accepted_at IS NOT NULL AND expires_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE rounds (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  start_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal','competition')),
  competition_id TEXT REFERENCES competitions(id),
  rules_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','aborted')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  finished_at INTEGER,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  UNIQUE (user_id, start_request_id),
  CHECK ((kind = 'personal' AND competition_id IS NULL) OR (kind = 'competition' AND competition_id IS NOT NULL)),
  CHECK (ends_at - starts_at = 60000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX rounds_one_active_per_user ON rounds(user_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX rounds_competition_user ON rounds(competition_id, user_id);
--> statement-breakpoint
CREATE INDEX rounds_user_history ON rounds(user_id, status, finished_at DESC);
--> statement-breakpoint
CREATE INDEX competitions_opponent ON competitions(opponent_id);
--> statement-breakpoint
CREATE TABLE daily_progress (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  local_date TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (user_id, local_date)
);
--> statement-breakpoint
CREATE TABLE daily_rewards (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  local_date TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 10 CHECK (points = 10),
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, local_date),
  FOREIGN KEY (user_id, local_date) REFERENCES daily_progress(user_id, local_date)
);
--> statement-breakpoint
CREATE TABLE repetition_events (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  round_id TEXT REFERENCES rounds(id),
  elapsed_ms INTEGER,
  round_eligible INTEGER NOT NULL DEFAULT 0 CHECK (round_eligible IN (0,1)),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
--> statement-breakpoint
CREATE TRIGGER repetition_updates_progress AFTER INSERT ON repetition_events
BEGIN
  INSERT INTO daily_progress (user_id, local_date, count)
  VALUES (NEW.user_id, NEW.local_date, 1)
  ON CONFLICT(user_id, local_date) DO UPDATE SET count = count + 1;
  INSERT INTO daily_rewards (user_id, local_date, points, awarded_at)
  SELECT NEW.user_id, NEW.local_date, 10, NEW.received_at
  WHERE (SELECT count FROM daily_progress WHERE user_id = NEW.user_id AND local_date = NEW.local_date) >= 10
  ON CONFLICT(user_id, local_date) DO NOTHING;
  UPDATE rounds SET count = count + 1
  WHERE id = NEW.round_id AND user_id = NEW.user_id AND status = 'active' AND NEW.round_eligible = 1;
END;

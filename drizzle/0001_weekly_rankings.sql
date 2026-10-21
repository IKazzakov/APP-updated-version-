ALTER TABLE profiles ADD COLUMN rankings_enabled INTEGER NOT NULL DEFAULT 0 CHECK (rankings_enabled IN (0,1));
--> statement-breakpoint
CREATE TABLE weekly_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  activated_at INTEGER NOT NULL,
  activation_week TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE weekly_periods (
  week TEXT PRIMARY KEY NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  closed_at INTEGER,
  CHECK (ends_at - starts_at = 604800000)
);
--> statement-breakpoint
CREATE TABLE weekly_standings (
  week TEXT NOT NULL REFERENCES weekly_periods(week),
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  score INTEGER NOT NULL CHECK (score > 0),
  place INTEGER NOT NULL CHECK (place > 0),
  PRIMARY KEY (week,user_id)
);
--> statement-breakpoint
CREATE TABLE weekly_participants (
  week TEXT NOT NULL REFERENCES weekly_periods(week),
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  PRIMARY KEY (week,user_id)
);
--> statement-breakpoint
CREATE TABLE weekly_bonuses (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  week TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('full_week','sport_place')),
  points INTEGER NOT NULL,
  awarded_at INTEGER NOT NULL,
  basis TEXT NOT NULL UNIQUE,
  PRIMARY KEY (user_id,week,type),
  CHECK ((type = 'full_week' AND points = 20) OR (type = 'sport_place' AND points IN (5,10,20)))
);
--> statement-breakpoint
CREATE INDEX weekly_bonuses_week ON weekly_bonuses(week,user_id);
--> statement-breakpoint
CREATE INDEX daily_rewards_date ON daily_rewards(local_date,user_id);
--> statement-breakpoint
CREATE INDEX rounds_weekly_results ON rounds(status,rules_version,ends_at,user_id);
--> statement-breakpoint
CREATE TABLE weekly_summaries (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  week TEXT NOT NULL REFERENCES weekly_periods(week),
  completed_days INTEGER NOT NULL,
  best INTEGER,
  sport_place INTEGER,
  participated INTEGER NOT NULL CHECK (participated IN (0,1)),
  daily_points INTEGER NOT NULL,
  full_week_points INTEGER NOT NULL,
  sport_points INTEGER NOT NULL,
  total INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  seen_at INTEGER,
  seen_total INTEGER,
  PRIMARY KEY (user_id,week)
);

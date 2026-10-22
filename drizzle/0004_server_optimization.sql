-- Additive migration: original event/reward tables remain the source of truth.
CREATE TABLE user_totals (
  user_id TEXT PRIMARY KEY REFERENCES profiles(user_id),
  points INTEGER NOT NULL DEFAULT 0,
  bonus_points INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO user_totals(user_id,points,bonus_points)
SELECT p.user_id,
  COALESCE((SELECT SUM(points) FROM daily_rewards WHERE user_id=p.user_id),0)+
  COALESCE((SELECT SUM(points) FROM weekly_bonuses WHERE user_id=p.user_id),0),
  COALESCE((SELECT SUM(points) FROM weekly_bonuses WHERE user_id=p.user_id),0)
FROM profiles p;
--> statement-breakpoint
CREATE TABLE week_points (
  week TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(week,user_id)
);
--> statement-breakpoint
INSERT INTO week_points(week,user_id,points)
SELECT week,user_id,SUM(points) FROM (
  SELECT date(local_date,'-6 days','weekday 1') AS week,user_id,points FROM daily_rewards
  UNION ALL SELECT week,user_id,points FROM weekly_bonuses
) GROUP BY week,user_id;
--> statement-breakpoint
CREATE INDEX week_points_rank ON week_points(week,points DESC,user_id);
--> statement-breakpoint
CREATE TABLE weekly_best (
  week TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  rules_version TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score>0),
  PRIMARY KEY(week,user_id,rules_version)
);
--> statement-breakpoint
INSERT INTO weekly_best(week,user_id,rules_version,score)
SELECT date(ends_at/1000+7200,'unixepoch','-6 days','weekday 1'),user_id,rules_version,MAX(count)
FROM rounds WHERE status='completed' AND count>0 AND ends_at-starts_at=60000 GROUP BY 1,2,3;
--> statement-breakpoint
CREATE INDEX weekly_best_rank ON weekly_best(week,rules_version,score DESC,user_id);
--> statement-breakpoint
CREATE INDEX user_totals_rank ON user_totals(points DESC,user_id);
--> statement-breakpoint
CREATE INDEX rounds_personal_record ON rounds(user_id,status,rules_version,count DESC);
--> statement-breakpoint
CREATE INDEX competitions_creator_history ON competitions(creator_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX competitions_opponent_history ON competitions(opponent_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE TABLE weekly_dirty (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  week TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id,week)
);
--> statement-breakpoint
INSERT INTO weekly_dirty(user_id,week)
SELECT DISTINCT user_id,date(local_date,'-6 days','weekday 1') FROM daily_rewards
WHERE local_date>=(SELECT activation_week FROM weekly_settings WHERE id=1);
--> statement-breakpoint
ALTER TABLE weekly_periods ADD COLUMN summary_cursor TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE weekly_periods ADD COLUMN summaries_complete INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE ranking_consent (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  changed_at INTEGER NOT NULL,
  excluded INTEGER NOT NULL CHECK(excluded IN(0,1)),
  PRIMARY KEY(user_id,changed_at)
);
--> statement-breakpoint
INSERT INTO ranking_consent SELECT user_id,created_at,rankings_excluded FROM profiles;
--> statement-breakpoint
CREATE TRIGGER totals_profile_insert AFTER INSERT ON profiles BEGIN
  INSERT INTO user_totals(user_id) VALUES(NEW.user_id);
  INSERT INTO ranking_consent VALUES(NEW.user_id,NEW.created_at,NEW.rankings_excluded);
END;
--> statement-breakpoint
CREATE TRIGGER totals_profile_update AFTER UPDATE ON profiles BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER totals_progress_insert AFTER INSERT ON daily_progress BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER totals_progress_update AFTER UPDATE ON daily_progress BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER totals_daily_reward AFTER INSERT ON daily_rewards BEGIN
  UPDATE user_totals SET points=points+NEW.points,revision=revision+1 WHERE user_id=NEW.user_id;
  INSERT INTO week_points(week,user_id,points) VALUES(date(NEW.local_date,'-6 days','weekday 1'),NEW.user_id,NEW.points)
    ON CONFLICT(week,user_id) DO UPDATE SET points=points+excluded.points;
  INSERT INTO weekly_dirty(user_id,week) VALUES(NEW.user_id,date(NEW.local_date,'-6 days','weekday 1'))
    ON CONFLICT(user_id,week) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER totals_weekly_bonus AFTER INSERT ON weekly_bonuses BEGIN
  UPDATE user_totals SET points=points+NEW.points,bonus_points=bonus_points+NEW.points,revision=revision+1 WHERE user_id=NEW.user_id;
  INSERT INTO week_points(week,user_id,points) VALUES(NEW.week,NEW.user_id,NEW.points)
    ON CONFLICT(week,user_id) DO UPDATE SET points=points+excluded.points;
END;
--> statement-breakpoint
CREATE TRIGGER totals_round_insert AFTER INSERT ON rounds BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
  INSERT INTO weekly_best(week,user_id,rules_version,score)
    SELECT date(NEW.ends_at/1000+7200,'unixepoch','-6 days','weekday 1'),NEW.user_id,NEW.rules_version,NEW.count
    WHERE NEW.status='completed' AND NEW.count>0 AND NEW.ends_at-NEW.starts_at=60000
    ON CONFLICT(week,user_id,rules_version) DO UPDATE SET score=MAX(score,excluded.score);
  INSERT INTO weekly_dirty(user_id,week)
    SELECT NEW.user_id,date(NEW.ends_at/1000+7200,'unixepoch','-6 days','weekday 1') WHERE NEW.status='completed'
    ON CONFLICT(user_id,week) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER totals_round_update AFTER UPDATE ON rounds BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
  INSERT INTO weekly_best(week,user_id,rules_version,score)
    SELECT date(NEW.ends_at/1000+7200,'unixepoch','-6 days','weekday 1'),NEW.user_id,NEW.rules_version,NEW.count
    WHERE NEW.status='completed' AND NEW.count>0 AND NEW.ends_at-NEW.starts_at=60000
    ON CONFLICT(week,user_id,rules_version) DO UPDATE SET score=MAX(score,excluded.score);
  INSERT INTO weekly_dirty(user_id,week)
    SELECT NEW.user_id,date(NEW.ends_at/1000+7200,'unixepoch','-6 days','weekday 1') WHERE NEW.status='completed'
    ON CONFLICT(user_id,week) DO UPDATE SET revision=revision+1;
END;
--> statement-breakpoint
CREATE TRIGGER totals_competition_insert AFTER INSERT ON competitions BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id IN(NEW.creator_id,NEW.opponent_id);
END;
--> statement-breakpoint
CREATE TRIGGER totals_competition_update AFTER UPDATE ON competitions BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id IN(NEW.creator_id,NEW.opponent_id);
END;
--> statement-breakpoint
-- Normal completed rounds are immutable. Administrative corrections still
-- rebuild the affected aggregate instead of retaining an invalid old maximum.
CREATE TRIGGER weekly_best_correction AFTER UPDATE ON rounds WHEN OLD.status='completed' BEGIN
  DELETE FROM weekly_best WHERE user_id=OLD.user_id AND rules_version=OLD.rules_version
    AND week=date(OLD.ends_at/1000+7200,'unixepoch','-6 days','weekday 1');
  INSERT INTO weekly_best(week,user_id,rules_version,score)
    SELECT date(ends_at/1000+7200,'unixepoch','-6 days','weekday 1'),user_id,rules_version,MAX(count)
    FROM rounds WHERE user_id=OLD.user_id AND rules_version=OLD.rules_version AND status='completed' AND count>0 AND ends_at-starts_at=60000
    AND ends_at>=CAST(strftime('%s',date(OLD.ends_at/1000+7200,'unixepoch','-6 days','weekday 1')||'T00:00:00+02:00') AS INTEGER)*1000
    AND ends_at<CAST(strftime('%s',date(OLD.ends_at/1000+7200,'unixepoch','-6 days','weekday 1')||'T00:00:00+02:00') AS INTEGER)*1000+604800000
    GROUP BY 1,2,3;
END;

--> statement-breakpoint
CREATE INDEX rounds_active_deadline ON rounds(status,ends_at);
--> statement-breakpoint
CREATE TRIGGER totals_summary_insert AFTER INSERT ON weekly_summaries BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER totals_summary_update AFTER UPDATE ON weekly_summaries BEGIN
  UPDATE user_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;

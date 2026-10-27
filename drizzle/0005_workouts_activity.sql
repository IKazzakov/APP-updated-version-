-- Additive workout/activity ledger. Existing sporting tables and rules are preserved.
CREATE TABLE activity_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  activated_at INTEGER NOT NULL
);
INSERT INTO activity_settings VALUES(1,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
--> statement-breakpoint
CREATE TABLE workout_sessions (
  id TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  program_id TEXT NOT NULL,
  program_version INTEGER NOT NULL CHECK(program_version=1),
  rules_version TEXT NOT NULL CHECK(rules_version='workout-v1'),
  program_json TEXT NOT NULL CHECK(json_valid(program_json)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','completed','aborted')),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms>=0),
  received_at INTEGER NOT NULL,
  CHECK(finished_at IS NULL OR (finished_at>=started_at AND finished_at<=started_at+86400000)),
  CHECK((status='active' AND finished_at IS NULL) OR (status!='active' AND finished_at IS NOT NULL))
);
CREATE INDEX workout_user_history ON workout_sessions(user_id,started_at DESC,id DESC);
CREATE INDEX workout_active_user ON workout_sessions(user_id,status,started_at);
--> statement-breakpoint
CREATE TABLE workout_steps (
  workout_id TEXT NOT NULL REFERENCES workout_sessions(id),
  step_index INTEGER NOT NULL CHECK(step_index>=0),
  exercise TEXT NOT NULL CHECK(exercise IN('squat','pushup','plank')),
  target INTEGER NOT NULL CHECK(target>0),
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress>=0 AND progress<=target),
  PRIMARY KEY(workout_id,step_index)
);
CREATE TABLE workout_events (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  id TEXT NOT NULL COLLATE NOCASE,
  workout_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  duration_ms INTEGER CHECK(duration_ms BETWEEN 1 AND 1000),
  PRIMARY KEY(user_id,id),
  FOREIGN KEY(workout_id,step_index) REFERENCES workout_steps(workout_id,step_index)
);
CREATE INDEX workout_event_session ON workout_events(workout_id,step_index,occurred_at);
--> statement-breakpoint
CREATE TABLE activity_events (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  id TEXT NOT NULL COLLATE NOCASE,
  exercise TEXT NOT NULL CHECK(exercise IN('squat','pushup','plank')),
  occurred_at INTEGER NOT NULL,
  duration_ms INTEGER,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,id),
  CHECK((exercise='plank' AND duration_ms IS NOT NULL AND duration_ms BETWEEN 1 AND 1000) OR (exercise!='plank' AND duration_ms IS NULL))
);
CREATE INDEX activity_hold_intervals ON activity_events(user_id,occurred_at) WHERE exercise='plank';
CREATE TABLE activity_event_parts (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL COLLATE NOCASE,
  local_date TEXT NOT NULL,
  squats INTEGER NOT NULL DEFAULT 0 CHECK(squats>=0),
  pushups INTEGER NOT NULL DEFAULT 0 CHECK(pushups>=0),
  plank_ms INTEGER NOT NULL DEFAULT 0 CHECK(plank_ms>=0),
  xp_squats INTEGER NOT NULL DEFAULT 0 CHECK(xp_squats BETWEEN 0 AND squats),
  xp_pushups INTEGER NOT NULL DEFAULT 0 CHECK(xp_pushups BETWEEN 0 AND pushups),
  xp_plank_ms INTEGER NOT NULL DEFAULT 0 CHECK(xp_plank_ms BETWEEN 0 AND plank_ms),
  PRIMARY KEY(user_id,event_id,local_date),
  FOREIGN KEY(user_id,event_id) REFERENCES activity_events(user_id,id)
);
CREATE TABLE activity_days (
  user_id TEXT NOT NULL REFERENCES profiles(user_id),
  local_date TEXT NOT NULL,
  squats INTEGER NOT NULL DEFAULT 0,
  pushups INTEGER NOT NULL DEFAULT 0,
  plank_ms INTEGER NOT NULL DEFAULT 0,
  xp_squats INTEGER NOT NULL DEFAULT 0,
  xp_pushups INTEGER NOT NULL DEFAULT 0,
  xp_plank_ms INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0 CHECK(xp BETWEEN 0 AND 300),
  PRIMARY KEY(user_id,local_date)
);
CREATE TABLE activity_totals (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES profiles(user_id),
  total_xp INTEGER NOT NULL DEFAULT 0 CHECK(total_xp>=0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO activity_totals(user_id) SELECT user_id FROM profiles;
--> statement-breakpoint
CREATE TRIGGER activity_profile_insert AFTER INSERT ON profiles BEGIN
  INSERT INTO activity_totals(user_id) VALUES(NEW.user_id);
END;
CREATE TRIGGER activity_part_insert AFTER INSERT ON activity_event_parts BEGIN
  INSERT INTO activity_days(user_id,local_date,squats,pushups,plank_ms,xp_squats,xp_pushups,xp_plank_ms)
    VALUES(NEW.user_id,NEW.local_date,NEW.squats,NEW.pushups,NEW.plank_ms,NEW.xp_squats,NEW.xp_pushups,NEW.xp_plank_ms)
    ON CONFLICT(user_id,local_date) DO UPDATE SET squats=squats+NEW.squats,pushups=pushups+NEW.pushups,
      plank_ms=plank_ms+NEW.plank_ms,xp_squats=xp_squats+NEW.xp_squats,
      xp_pushups=xp_pushups+NEW.xp_pushups,xp_plank_ms=xp_plank_ms+NEW.xp_plank_ms;
  UPDATE activity_totals SET total_xp=total_xp+(SELECT MIN(300,xp_squats+xp_pushups+xp_plank_ms/5000)-xp
    FROM activity_days WHERE user_id=NEW.user_id AND local_date=NEW.local_date),revision=revision+1
    WHERE user_id=NEW.user_id;
  UPDATE activity_days SET xp=MIN(300,xp_squats+xp_pushups+xp_plank_ms/5000)
    WHERE user_id=NEW.user_id AND local_date=NEW.local_date;
END;
--> statement-breakpoint
CREATE TRIGGER activity_event_guard BEFORE INSERT ON activity_events BEGIN
  SELECT RAISE(ABORT,'REQUEST_REUSED') WHERE EXISTS(SELECT 1 FROM repetition_events r WHERE r.user_id=NEW.user_id AND r.id=NEW.id COLLATE NOCASE AND (NEW.exercise!='squat' OR r.occurred_at!=NEW.occurred_at OR NEW.duration_ms IS NOT NULL));
  SELECT RAISE(ABORT,'REQUEST_REUSED') WHERE EXISTS(SELECT 1 FROM activity_events a
    WHERE a.user_id=NEW.user_id AND a.id=NEW.id AND
      (a.exercise IS NOT NEW.exercise OR a.occurred_at IS NOT NEW.occurred_at OR a.duration_ms IS NOT NEW.duration_ms));
  SELECT RAISE(ABORT,'ACTIVITY_INTERVAL_OVERLAP') WHERE NEW.exercise='plank' AND EXISTS(
    SELECT 1 FROM activity_events a WHERE a.user_id=NEW.user_id AND a.id!=NEW.id AND a.exercise='plank'
      AND a.occurred_at<NEW.occurred_at+NEW.duration_ms AND a.occurred_at+a.duration_ms>NEW.occurred_at);
END;
CREATE TRIGGER activity_legacy_guard BEFORE INSERT ON repetition_events WHEN NOT EXISTS(SELECT 1 FROM repetition_events WHERE user_id=NEW.user_id AND id=NEW.id) BEGIN
  SELECT RAISE(ABORT,'REQUEST_REUSED') WHERE EXISTS(SELECT 1 FROM activity_events a
    WHERE a.user_id=NEW.user_id AND a.id=NEW.id AND
      (a.exercise!='squat' OR a.occurred_at!=NEW.occurred_at OR a.duration_ms IS NOT NULL));
END;
CREATE TRIGGER activity_from_legacy AFTER INSERT ON repetition_events BEGIN
  INSERT INTO activity_events(user_id,id,exercise,occurred_at,duration_ms,received_at)
    VALUES(NEW.user_id,NEW.id,'squat',NEW.occurred_at,NULL,NEW.received_at) ON CONFLICT(user_id,id) DO NOTHING;
  INSERT INTO activity_event_parts(user_id,event_id,local_date,squats,xp_squats)
    SELECT NEW.user_id,NEW.id,NEW.local_date,1,CASE WHEN NEW.occurred_at>=activated_at THEN 1 ELSE 0 END
    FROM activity_settings WHERE id=1 ON CONFLICT(user_id,event_id,local_date) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER workout_start_guard BEFORE INSERT ON workout_sessions BEGIN
  SELECT RAISE(ABORT,'REQUEST_REUSED') WHERE EXISTS(SELECT 1 FROM workout_sessions w WHERE w.id=NEW.id AND
    (w.user_id IS NOT NEW.user_id OR w.program_id IS NOT NEW.program_id OR w.started_at IS NOT NEW.started_at));
  SELECT RAISE(ABORT,'ACTIVE_ROUND') WHERE NOT EXISTS(SELECT 1 FROM workout_sessions WHERE id=NEW.id)
    AND EXISTS(SELECT 1 FROM rounds r WHERE r.user_id=NEW.user_id AND r.status='active' AND r.ends_at+15000>=NEW.received_at);
  SELECT RAISE(ABORT,'ACTIVE_WORKOUT') WHERE NOT EXISTS(SELECT 1 FROM workout_sessions WHERE id=NEW.id)
    AND EXISTS(SELECT 1 FROM workout_sessions w WHERE w.user_id=NEW.user_id AND w.status='active'
      AND w.started_at+86400000>=NEW.received_at);
END;
CREATE TRIGGER workout_blocks_round BEFORE INSERT ON rounds BEGIN
  SELECT RAISE(ABORT,'ACTIVE_WORKOUT') WHERE NOT EXISTS(SELECT 1 FROM rounds WHERE user_id=NEW.user_id AND start_request_id=NEW.start_request_id)
    AND EXISTS(SELECT 1 FROM workout_sessions w WHERE w.user_id=NEW.user_id AND w.status='active' AND w.started_at+86400000>=NEW.starts_at);
END;
CREATE TRIGGER workout_event_guard BEFORE INSERT ON workout_events BEGIN
  SELECT RAISE(ABORT,'REQUEST_REUSED') WHERE EXISTS(SELECT 1 FROM workout_sessions w WHERE w.id=NEW.workout_id AND w.user_id!=NEW.user_id);
  SELECT RAISE(ABORT,'INVALID_WORKOUT_DURATION') WHERE EXISTS(SELECT 1 FROM workout_steps s WHERE s.workout_id=NEW.workout_id AND s.step_index=NEW.step_index AND ((s.exercise='plank' AND NEW.duration_ms IS NULL) OR (s.exercise!='plank' AND NEW.duration_ms IS NOT NULL)));
  SELECT RAISE(ABORT,'INVALID_WORKOUT_TIME') WHERE EXISTS(SELECT 1 FROM workout_sessions w WHERE w.id=NEW.workout_id AND (NEW.occurred_at<w.started_at OR NEW.occurred_at+COALESCE(NEW.duration_ms,0)>w.started_at+86400000));
  SELECT RAISE(ABORT,'REQUEST_REUSED') WHERE EXISTS(SELECT 1 FROM workout_events e WHERE e.user_id=NEW.user_id AND e.id=NEW.id AND
    (e.workout_id IS NOT NEW.workout_id OR e.step_index IS NOT NEW.step_index OR e.occurred_at IS NOT NEW.occurred_at OR e.duration_ms IS NOT NEW.duration_ms));
  SELECT RAISE(ABORT,'WORKOUT_CLOSED') WHERE NOT EXISTS(SELECT 1 FROM workout_events WHERE user_id=NEW.user_id AND id=NEW.id)
    AND EXISTS(SELECT 1 FROM workout_sessions w WHERE w.id=NEW.workout_id AND w.status!='active');
  SELECT RAISE(ABORT,'WORKOUT_TARGET_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM workout_events WHERE user_id=NEW.user_id AND id=NEW.id)
    AND EXISTS(SELECT 1 FROM workout_steps s WHERE s.workout_id=NEW.workout_id AND s.step_index=NEW.step_index AND s.progress+COALESCE(NEW.duration_ms,1)>s.target);
  SELECT RAISE(ABORT,'WORKOUT_STEP_ORDER') WHERE NOT EXISTS(SELECT 1 FROM workout_events WHERE user_id=NEW.user_id AND id=NEW.id)
    AND EXISTS(SELECT 1 FROM workout_steps s WHERE s.workout_id=NEW.workout_id AND s.step_index<NEW.step_index AND s.progress<s.target);
END;
CREATE TRIGGER workout_event_progress AFTER INSERT ON workout_events BEGIN
  UPDATE workout_steps SET progress=progress+COALESCE(NEW.duration_ms,1)
    WHERE workout_id=NEW.workout_id AND step_index=NEW.step_index;
  UPDATE activity_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER workout_session_insert AFTER INSERT ON workout_sessions BEGIN
  UPDATE activity_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER workout_session_update AFTER UPDATE OF status ON workout_sessions WHEN OLD.status!=NEW.status BEGIN
  UPDATE activity_totals SET revision=revision+1 WHERE user_id=NEW.user_id;
END;

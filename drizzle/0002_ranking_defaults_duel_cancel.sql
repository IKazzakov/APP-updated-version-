ALTER TABLE profiles ADD COLUMN rankings_excluded INTEGER NOT NULL DEFAULT 0 CHECK (rankings_excluded IN (0,1));
--> statement-breakpoint
ALTER TABLE competitions ADD COLUMN cancelled_at INTEGER;

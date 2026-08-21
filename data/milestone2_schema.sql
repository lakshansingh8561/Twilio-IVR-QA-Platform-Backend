-- ====================================================================
-- Milestone 2 Database Schema Migration Script
-- Production-Ready Supabase SQL Setup for Multiple 16-Digit Values & 3-Digit Test Codes
-- ====================================================================

-- 1. Ensure 'attempts' table exists with all standard and Milestone 2 fields
CREATE TABLE IF NOT EXISTS attempts (
  id SERIAL PRIMARY KEY,
  attempt_id VARCHAR(100) UNIQUE,
  sixteen_digit VARCHAR(16),
  target_test_code VARCHAR(3),
  current_test_code VARCHAR(3) DEFAULT '001',
  test_value VARCHAR(255),
  target_phone_number VARCHAR(50),
  phone_line_id INT,
  call_sid VARCHAR(100),
  batch_id VARCHAR(100),
  status VARCHAR(50) DEFAULT 'queued',
  retry_count INT DEFAULT 0,
  duration INT DEFAULT 0,
  result_details JSONB DEFAULT '{}'::jsonb,
  logs JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- 2. Add missing columns safely if the table already existed
DO $$ 
BEGIN 
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='attempt_id') THEN
    ALTER TABLE attempts ADD COLUMN attempt_id VARCHAR(100) UNIQUE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='sixteen_digit') THEN
    ALTER TABLE attempts ADD COLUMN sixteen_digit VARCHAR(16);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='target_test_code') THEN
    ALTER TABLE attempts ADD COLUMN target_test_code VARCHAR(3);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='current_test_code') THEN
    ALTER TABLE attempts ADD COLUMN current_test_code VARCHAR(3) DEFAULT '001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='batch_id') THEN
    ALTER TABLE attempts ADD COLUMN batch_id VARCHAR(100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='retry_count') THEN
    ALTER TABLE attempts ADD COLUMN retry_count INT DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='result_details') THEN
    ALTER TABLE attempts ADD COLUMN result_details JSONB DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='from_number') THEN
    ALTER TABLE attempts ADD COLUMN from_number VARCHAR(50);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='destination_number') THEN
    ALTER TABLE attempts ADD COLUMN destination_number VARCHAR(50);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='matched_code') THEN
    ALTER TABLE attempts ADD COLUMN matched_code VARCHAR(3);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='start_time') THEN
    ALTER TABLE attempts ADD COLUMN start_time TIMESTAMP WITH TIME ZONE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='end_time') THEN
    ALTER TABLE attempts ADD COLUMN end_time TIMESTAMP WITH TIME ZONE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='recording_sid') THEN
    ALTER TABLE attempts ADD COLUMN recording_sid VARCHAR(100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='recording_status') THEN
    ALTER TABLE attempts ADD COLUMN recording_status VARCHAR(50);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='attempts' AND column_name='recording_url') THEN
    ALTER TABLE attempts ADD COLUMN recording_url TEXT;
  END IF;
END $$;

-- 3. Create Indexes for High Performance Queue Claiming and Lookups
CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status);
CREATE INDEX IF NOT EXISTS idx_attempts_batch_id ON attempts(batch_id);
CREATE INDEX IF NOT EXISTS idx_attempts_attempt_id ON attempts(attempt_id);
CREATE INDEX IF NOT EXISTS idx_attempts_call_sid ON attempts(call_sid);

-- 4. Stored Procedure for Atomic Queue Locking (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION claim_next_attempt(p_line_id INT)
RETURNS SETOF attempts AS $$
DECLARE
  v_attempt attempts;
BEGIN
  -- Atomically pick and update the next queued or retry attempt
  SELECT * INTO v_attempt
  FROM attempts
  WHERE status IN ('queued', 'retry')
  ORDER BY id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_attempt.id IS NOT NULL THEN
    UPDATE attempts
    SET status = 'in_progress',
        phone_line_id = p_line_id,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_attempt.id;

    RETURN QUERY SELECT * FROM attempts WHERE id = v_attempt.id;
  END IF;
  RETURN;
END;
$$ LANGUAGE plpgsql;

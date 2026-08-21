import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
import bcrypt from 'bcryptjs';
import WebSocket from 'ws';

if (!global.WebSocket) {
  global.WebSocket = WebSocket;
}
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey || supabaseKey.includes('YOUR_SUPABASE_SERVICE_ROLE_KEY')) {
  console.warn('\n======================================================');
  console.warn('WARNING: Missing or default SUPABASE_SERVICE_ROLE_KEY.');
  console.warn('Please fill in SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  console.warn('======================================================\n');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder', {
  auth: {
    persistSession: false
  }
});

const initializeDatabase = async () => {
  console.log('Supabase HTTP client initialized successfully.');

  try {
    const { error: lineError } = await supabase
      .from('phone_lines')
      .update({ status: 'idle', current_attempt_id: null })
      .neq('id', 0); // Target all lines safely

    if (lineError) {
      console.error('Failed to reset phone lines status on boot:', lineError);
    } else {
      console.log('Successfully reset all phone lines status to idle on startup.');
    }

    // Crash Recovery: Reset stuck 'active', 'in_progress', 'testing_3digit' attempts to 'retry'
    const { error: attemptError } = await supabase
      .from('attempts')
      .update({ status: 'retry' })
      .in('status', ['active', 'in_progress', 'testing_3digit']);

    if (attemptError) {
      console.error('Failed to reset stuck attempts on boot:', attemptError.message);
    } else {
      console.log('Successfully swept stuck active/in_progress attempts to retry.');
    }
  } catch (err) {
    console.error('Error during crash recovery on startup:', err);
  }

  // Milestone 2 Schema Verification: Check attempts table for Milestone 2 columns
  try {
    const { data: testRow, error: checkError } = await supabase
      .from('attempts')
      .select('attempt_id, sixteen_digit, target_test_code, current_test_code')
      .limit(1);

    if (checkError) {
      console.warn('\n======================================================');
      console.warn('NOTICE: Milestone 2 columns might be missing in "attempts" table.');
      console.warn('Details:', checkError.message);
      console.warn('To ensure production-level compatibility, run backend/data/milestone2_schema.sql in your Supabase SQL Editor.');
      console.warn('======================================================\n');
    } else {
      console.log('Milestone 2 database schema verified successfully.');
    }
  } catch (err) {
    console.warn('Schema check warning:', err.message);
  }

  // Verify admins table exists and seed default admin
  try {
    const { data: admins, error: selectError } = await supabase
      .from('admins')
      .select('*')
      .limit(1);

    if (selectError) {
      console.warn('\n======================================================');
      console.warn('WARNING: Could not fetch from "admins" table. It may not exist!');
      console.warn('Error details:', selectError.message);
      console.warn('Please run the following SQL command in your Supabase SQL Editor:');
      console.warn(`
        CREATE TABLE IF NOT EXISTS admins (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'admin',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
        );
      `);
      console.warn('======================================================\n');
    } else {
      // Check if admin is already seeded
      const { data: adminCount, error: countErr } = await supabase
        .from('admins')
        .select('*', { count: 'exact', head: true });

      if (!countErr && (adminCount === 0 || adminCount === null)) {
        console.log('Seeding default administrator account...');
        const defaultHash = await bcrypt.hash('admin123', 10);
        const { error: insertError } = await supabase
          .from('admins')
          .insert({
            email: 'admin@gmail.com',
            password_hash: defaultHash,
            role: 'admin'
          });

        if (insertError) {
          console.error('Failed to seed default admin:', insertError.message);
        } else {
          console.log('Default admin seeded: admin@gmail.com / admin123');
        }
      }
    }
  } catch (err) {
    console.error('Error during database schema checks:', err);
  }
};

export { supabase, initializeDatabase };

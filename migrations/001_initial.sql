CREATE SCHEMA IF NOT EXISTS attendance_app;

CREATE TABLE attendance_app.profiles (
  id uuid PRIMARY KEY,
  google_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  name text NOT NULL,
  avatar_url text,
  role text NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('ADMIN','STUDENT')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_login_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX profiles_name_idx ON attendance_app.profiles (lower(name));
CREATE INDEX profiles_email_idx ON attendance_app.profiles (lower(email));

CREATE TABLE attendance_app.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  created_by uuid NOT NULL REFERENCES attendance_app.profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz
);
CREATE INDEX courses_owner_idx ON attendance_app.courses(created_by);
CREATE TABLE attendance_app.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES attendance_app.courses(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  class_date timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL REFERENCES attendance_app.profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz
);
CREATE INDEX classes_course_idx ON attendance_app.classes(course_id,created_at DESC);
CREATE TABLE attendance_app.attendance_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL UNIQUE REFERENCES attendance_app.classes(id),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','CANCELLED')),
  created_by uuid NOT NULL REFERENCES attendance_app.profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(expires_at > started_at)
);
CREATE TABLE attendance_app.check_in_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES attendance_app.attendance_sessions(id),
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  user_id uuid REFERENCES attendance_app.profiles(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED')),
  CHECK ((status = 'PENDING' AND used_at IS NULL AND user_id IS NULL) OR
         (status = 'COMPLETED' AND used_at IS NOT NULL AND user_id IS NOT NULL))
);
CREATE INDEX attempts_expiry_idx ON attendance_app.check_in_attempts(expires_at);
CREATE INDEX attempts_session_idx ON attendance_app.check_in_attempts(session_id);
CREATE TABLE attendance_app.attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES attendance_app.attendance_sessions(id),
  user_id uuid NOT NULL REFERENCES attendance_app.profiles(id),
  checked_in_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'PRESENT' CHECK(status IN ('PRESENT','VOIDED')),
  source text NOT NULL CHECK(source IN ('QR','MANUAL')),
  created_by uuid NOT NULL REFERENCES attendance_app.profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at timestamptz,
  voided_by uuid REFERENCES attendance_app.profiles(id),
  reason text,
  UNIQUE(session_id,user_id),
  CHECK ((status='PRESENT' AND voided_at IS NULL AND voided_by IS NULL) OR
         (status='VOIDED' AND voided_at IS NOT NULL AND voided_by IS NOT NULL))
);
CREATE INDEX attendance_present_idx ON attendance_app.attendance(session_id,checked_in_at) WHERE status='PRESENT';

-- Private schema: never add attendance_app to Supabase exposed API schemas.
-- No browser role receives access; the Nest database role is the only writer.
REVOKE ALL ON SCHEMA attendance_app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA attendance_app FROM PUBLIC;
ALTER TABLE attendance_app.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_app.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_app.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_app.attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_app.check_in_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_app.attendance ENABLE ROW LEVEL SECURITY;

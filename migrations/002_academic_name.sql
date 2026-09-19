ALTER TABLE attendance_app.profiles
  ADD COLUMN academic_first_name text,
  ADD COLUMN academic_last_name text,
  ADD CONSTRAINT academic_name_complete CHECK (
    (academic_first_name IS NULL AND academic_last_name IS NULL) OR
    (academic_first_name IS NOT NULL AND academic_last_name IS NOT NULL
      AND length(trim(academic_first_name)) BETWEEN 1 AND 100
      AND length(trim(academic_last_name)) BETWEEN 1 AND 100)
  );
-- Existing Google names are deliberately not treated as academic names.

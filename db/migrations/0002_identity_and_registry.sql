-- 0002_identity_and_registry.sql — the tables of Area 2, Identity and registry (Teammate A).
-- Names, phones and plates live only in the personal_data schema (ADR-06, Rule F, fitness function F10). Every other
-- table holds a person reference or a car reference, never the data itself.
-- Run as the database owner after 0001_schemas.sql. Safe to run twice.

-- People as the rest of the system sees them: a reference, one role and an account status (task A1, A2).
CREATE TABLE IF NOT EXISTS accounts_and_access_control.people (
  person_id  text PRIMARY KEY,
  role       text NOT NULL CHECK (role IN ('driver', 'attendant', 'inspector', 'member', 'chair')),
  status     text NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
  erased     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A person's name and phone (task A2). Removed by erasure (task A5); the people row stays.
CREATE TABLE IF NOT EXISTS personal_data.person_details (
  person_ref   text PRIMARY KEY REFERENCES accounts_and_access_control.people (person_id),
  display_name text NOT NULL,
  phone        text NOT NULL UNIQUE
);

-- Cars and their plates (task A4). Other tables hold car_ref only; showing a plate is a logged join.
CREATE TABLE IF NOT EXISTS personal_data.cars (
  car_ref   text PRIMARY KEY,
  owner_ref text NOT NULL REFERENCES accounts_and_access_control.people (person_id),
  plate     text NOT NULL,
  UNIQUE (owner_ref, plate)
);

-- Erasure deletes personal rows, so the application role may delete in personal_data but nowhere in audit_log.
GRANT SELECT, INSERT, UPDATE ON accounts_and_access_control.people TO sayes_application;
GRANT SELECT, INSERT, DELETE ON personal_data.person_details, personal_data.cars TO sayes_application;

-- What access control knows about each person's licence and posts (task A3). Written by the licensing module inside
-- its own transaction, so that permission answers never wait on that may-fail module (Rule D). bound_site_id is the
-- site an attendant's session is bound to at clock-in.
CREATE TABLE IF NOT EXISTS accounts_and_access_control.access_facts (
  person_id          text PRIMARY KEY REFERENCES accounts_and_access_control.people (person_id),
  licence_state      text CHECK (licence_state IN ('valid', 'suspended', 'revoked')),
  attendant_site_id  text,
  inspector_zone_id  text,
  member_district_id text,
  bound_site_id      text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON accounts_and_access_control.access_facts TO sayes_application;

-- The one outstanding sign-in code of each person, kept only as a hash, with the wrong-code count and the lock-out
-- (task A1). Times come from the server clock.
CREATE TABLE IF NOT EXISTS accounts_and_access_control.sign_in_challenges (
  person_id       text PRIMARY KEY REFERENCES accounts_and_access_control.people (person_id),
  code_hash       char(64) NOT NULL,
  expires_at      timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON accounts_and_access_control.sign_in_challenges TO sayes_application;

-- Districts, zones and sites (task A6). "label" rather than "name": names are personal data (fitness function F10).
CREATE TABLE IF NOT EXISTS sites_and_areas.districts (
  district_id text PRIMARY KEY,
  label       text NOT NULL
);

CREATE TABLE IF NOT EXISTS sites_and_areas.zones (
  zone_id     text PRIMARY KEY,
  district_id text NOT NULL REFERENCES sites_and_areas.districts (district_id),
  label       text NOT NULL
);

-- The outline is a JSON array of { latitude, longitude } points. Capacity lives in capacity_changes, never here.
CREATE TABLE IF NOT EXISTS sites_and_areas.sites (
  site_id text PRIMARY KEY,
  zone_id text NOT NULL REFERENCES sites_and_areas.zones (zone_id),
  label   text NOT NULL,
  outline jsonb NOT NULL
);

-- Every capacity a site has ever had, with the reason and the server time (task A8). Insert-only: the latest row is
-- the current capacity.
CREATE TABLE IF NOT EXISTS sites_and_areas.capacity_changes (
  site_id    text NOT NULL REFERENCES sites_and_areas.sites (site_id),
  capacity   integer NOT NULL CHECK (capacity BETWEEN 1 AND 10000),
  reason     text NOT NULL CHECK (length(trim(reason)) > 0),
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (site_id, changed_at)
);

GRANT SELECT, INSERT, UPDATE ON sites_and_areas.districts, sites_and_areas.zones, sites_and_areas.sites TO sayes_application;
GRANT SELECT, INSERT ON sites_and_areas.capacity_changes TO sayes_application;

-- Who works where (task A12): an attendant at one fixed site with a changeable shift, an inspector over one zone, a
-- member over one district. The primary keys enforce one site per attendant, one zone per inspector and one district
-- per member. Each change is mirrored into accounts_and_access_control.access_facts in the same transaction.
CREATE TABLE IF NOT EXISTS licensing_assignment_attendance.attendant_assignments (
  attendant_id text PRIMARY KEY,
  site_id      text NOT NULL,
  shift_id     text NOT NULL,
  assigned_by  text NOT NULL,
  assigned_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS licensing_assignment_attendance.inspector_assignments (
  inspector_id text PRIMARY KEY,
  zone_id      text NOT NULL,
  assigned_by  text NOT NULL,
  assigned_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS licensing_assignment_attendance.member_appointments (
  member_id    text PRIMARY KEY,
  district_id  text NOT NULL,
  appointed_by text NOT NULL,
  appointed_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  licensing_assignment_attendance.attendant_assignments,
  licensing_assignment_attendance.inspector_assignments,
  licensing_assignment_attendance.member_appointments
TO sayes_application;

-- Attendant licences (task A11). One licence per attendant. The state is never stored on the licence: it is the
-- target of the latest row in licence_state_changes, an insert-only history where every move after the issue names
-- the approved request that ordered it.
CREATE TABLE IF NOT EXISTS licensing_assignment_attendance.licences (
  licence_id   text PRIMARY KEY,
  attendant_id text NOT NULL UNIQUE,
  issued_by    text NOT NULL,
  issued_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS licensing_assignment_attendance.licence_state_changes (
  licence_id          text NOT NULL REFERENCES licensing_assignment_attendance.licences (licence_id),
  from_state          text CHECK (from_state IN ('valid', 'suspended')),
  to_state            text NOT NULL CHECK (to_state IN ('valid', 'suspended', 'revoked')),
  approval_request_id text,
  changed_at          timestamptz NOT NULL,
  CHECK ((from_state IS NULL AND approval_request_id IS NULL) OR (from_state IS NOT NULL AND approval_request_id IS NOT NULL))
);

GRANT SELECT, INSERT ON licensing_assignment_attendance.licences, licensing_assignment_attendance.licence_state_changes TO sayes_application;

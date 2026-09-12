-- JUIT Smart Shuttle — PostgreSQL schema for Supabase
-- Run this in the Supabase SQL Editor to create all tables

-- ============================================================
-- Students table
-- ============================================================
CREATE TABLE IF NOT EXISTS students (
  roll_number   BIGINT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  room_number   VARCHAR(20)  NOT NULL,
  hostel_name   VARCHAR(50)  NOT NULL,
  phone_number  VARCHAR(20)  NOT NULL,
  password      VARCHAR(160) NOT NULL
);

-- ============================================================
-- Credentials (guard, scheduler)
-- ============================================================
CREATE TABLE IF NOT EXISTS credentials (
  role     VARCHAR(20) PRIMARY KEY,
  password VARCHAR(160) NOT NULL
);

-- Seed default accounts (change passwords after first login!)
INSERT INTO credentials (role, password) VALUES
  ('guard', 'admin'),
  ('scheduler', 'admin')
ON CONFLICT (role) DO NOTHING;

-- ============================================================
-- Pickup requests
-- ============================================================
CREATE TABLE IF NOT EXISTS pickup_requests (
  request_number     INTEGER PRIMARY KEY,
  student_roll_number BIGINT NOT NULL REFERENCES students(roll_number),
  pickup_place       VARCHAR(50)  NOT NULL,
  dropoff_place      VARCHAR(50)  NOT NULL,
  pickup_location    INTEGER NOT NULL,
  dropoff_location   INTEGER NOT NULL,
  direction          INTEGER NOT NULL,
  status             VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL'
);

-- ============================================================
-- Buses
-- ============================================================
CREATE TABLE IF NOT EXISTS buses (
  bus_number      INTEGER PRIMARY KEY,
  route_pickup    INTEGER NOT NULL,
  route_dropoff   INTEGER NOT NULL,
  current_count   INTEGER NOT NULL DEFAULT 0,
  max_capacity    INTEGER NOT NULL DEFAULT 30
);

-- ============================================================
-- Bus assignments
-- ============================================================
CREATE TABLE IF NOT EXISTS bus_assignments (
  request_number INTEGER PRIMARY KEY REFERENCES pickup_requests(request_number),
  bus_number     INTEGER NOT NULL REFERENCES buses(bus_number)
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_requests_status    ON pickup_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_student   ON pickup_requests(student_roll_number);
CREATE INDEX IF NOT EXISTS idx_requests_pending   ON pickup_requests(status) WHERE status = 'PENDING_APPROVAL';
CREATE INDEX IF NOT EXISTS idx_assignments_bus    ON bus_assignments(bus_number);

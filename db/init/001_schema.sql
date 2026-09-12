-- Campus Shuttle Telemetry — core schema
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE vehicle (
  id           text PRIMARY KEY,
  label        text        NOT NULL,
  fleet        text        NOT NULL DEFAULT 'campus-shuttle',
  vehicle_type text        NOT NULL DEFAULT 'shuttle',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- device_ts is the clock ON the vehicle; received_at is ours. They are
-- deliberately separate: a unit that buffers through a tunnel replays old
-- device_ts values minutes later, so anything ordered by arrival time is
-- wrong. Everything downstream sorts on device_ts.
CREATE TABLE telemetry (
  vehicle_id   text        NOT NULL REFERENCES vehicle(id),
  device_ts    timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  seq          bigint      NOT NULL,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  speed_kph    double precision NOT NULL,
  heading_deg  double precision NOT NULL,
  battery_pct  double precision,
  ignition     boolean     NOT NULL,
  doors_locked boolean     NOT NULL,
  odometer_km  double precision NOT NULL,
  PRIMARY KEY (vehicle_id, device_ts)
);

SELECT create_hypertable('telemetry', 'device_ts', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX telemetry_vehicle_recent_idx ON telemetry (vehicle_id, device_ts DESC);

-- Connection state, driven by MQTT connect / last-will. Small and mutable,
-- so it stays a plain table rather than a hypertable.
CREATE TABLE vehicle_status (
  vehicle_id text PRIMARY KEY REFERENCES vehicle(id),
  online     boolean     NOT NULL DEFAULT false,
  last_seen  timestamptz,
  changed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vehicle (id, label) VALUES ('shuttle-01', 'Campus Loop 01')
ON CONFLICT DO NOTHING;
INSERT INTO vehicle_status (vehicle_id) VALUES ('shuttle-01')
ON CONFLICT DO NOTHING;

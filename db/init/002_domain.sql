CREATE TABLE zone (
  id             text PRIMARY KEY,
  name           text        NOT NULL,
  inside_allowed boolean     NOT NULL,
  polygon        jsonb       NOT NULL,
  speed_limit_kph double precision,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert (
  vehicle_id   text        NOT NULL REFERENCES vehicle(id),
  alert_type   text        NOT NULL,
  subject      text        NOT NULL DEFAULT '',
  opened_at    timestamptz NOT NULL,            -- device time NOT detection time
  closed_at    timestamptz,
  close_reason text,
  lat          double precision,
  lon          double precision,
  peak         double precision,
  detail       jsonb,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, alert_type, subject, opened_at)
);

CREATE INDEX alert_open_idx ON alert (vehicle_id, alert_type, subject)
  WHERE closed_at IS NULL;

CREATE INDEX alert_recent_idx ON alert (opened_at DESC);
CREATE TABLE detector_cursor (
  id                text PRIMARY KEY DEFAULT 'default',
  last_processed_ts timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO detector_cursor (id) VALUES ('default') ON CONFLICT DO NOTHING;

INSERT INTO zone (id, name, inside_allowed, polygon, speed_limit_kph) VALUES
  ('campus-boundary', 'Campus boundary', true,
   '[[40.0100,-83.0360],[40.0100,-83.0190],[39.9960,-83.0190],[39.9960,-83.0360],[40.0100,-83.0360]]',
   NULL),
  ('service-yard', 'Service yard', false,
   '[[40.0045,-83.0345],[40.0045,-83.0325],[40.0030,-83.0325],[40.0030,-83.0345],[40.0045,-83.0345]]',
   NULL)
ON CONFLICT DO NOTHING;
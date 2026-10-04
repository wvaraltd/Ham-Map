CREATE TABLE IF NOT EXISTS operators (
  id BIGSERIAL PRIMARY KEY,
  callsign TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS single_operator_only ON operators ((true));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  operator_id BIGINT PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qsos (
  id BIGSERIAL PRIMARY KEY,
  operator_id BIGINT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  station_callsign TEXT NOT NULL,
  contact_callsign TEXT NOT NULL,
  qso_time TIMESTAMPTZ NOT NULL,
  frequency_mhz NUMERIC(10,6),
  band TEXT,
  mode TEXT NOT NULL,
  rst_sent TEXT,
  rst_received TEXT,
  station_grid TEXT,
  contact_grid TEXT,
  operation_mode TEXT NOT NULL DEFAULT 'home',
  pota_reference TEXT,
  sota_reference TEXT,
  activation_name TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_uid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS qsos_source_uid_unique
  ON qsos(operator_id, source, source_uid)
  WHERE source_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS qsos_time_idx ON qsos(operator_id, qso_time DESC);
CREATE INDEX IF NOT EXISTS qsos_contact_idx ON qsos(operator_id, contact_callsign);

CREATE TABLE IF NOT EXISTS notification_settings (
  operator_id BIGINT PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  pushover_user_key TEXT,
  pushover_app_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Driver declines and the Wait-and-Save offer (assessment lifecycle).
--
-- declined_by     drivers who dismissed this pending request; it disappears
--                  from their list but stays open for everyone else, and is
--                  cleared the moment any driver accepts it.
-- wait_and_save   passenger agreed to hold out for extra discount after
--                  being matched (PRD §5 stretch: +5% for waiting).
-- wait_deadline   when the wait promise expires (demo: 30s).

ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS declined_by TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS wait_and_save BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS wait_deadline TIMESTAMPTZ;

-- The offer is shown once the passenger has actually answered (either way),
-- so "No thanks" stops nagging while the trip continues.
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS wait_decided_at TIMESTAMPTZ;

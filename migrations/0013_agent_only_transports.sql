-- Remove every access-device transport except the EstateMate agent method
-- (isapi_bridge / windows_agent / isapi_windows_agent), which streams events
-- from the device's ISAPI alertStream and applies card operations by polling.
--
-- Devices still registered on the retired transports (direct HTTP Listening,
-- Render HTTPS relay, Hikvision cloud/OpenAPI, dedicated ISUP gateway) are
-- moved to manual synchronization so their history keeps referential integrity
-- and pending hardware actions become visible operator tasks until the device
-- is linked to an agent. Historical rows keep their old pattern values in the
-- audit trail; this migration only re-points the live device configuration.

UPDATE hikvision_devices
   SET connection_pattern = 'manual_sync',
       integration_mode = 'manual',
       updated_at = datetime('now')
 WHERE connection_pattern IN ('direct_http_listener','render_http_bridge','hikvision_cloud_openapi','offsite_isup_gateway');

-- The optional Render relay origin no longer has any consumer.
DELETE FROM settings WHERE key = 'render_bridge_url';

PRAGMA foreign_key_check;

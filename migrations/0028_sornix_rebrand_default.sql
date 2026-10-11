-- Default portal identity updated to Sornix EstateOS where the initial
-- seed values have not been customized by an administrator.
UPDATE settings
   SET value = 'Sornix EstateOS',
       updated_at = datetime('now')
 WHERE key = 'portal_name'
   AND value = 'EstateMate';

UPDATE settings
   SET value = 'Sornix Estate',
       updated_at = datetime('now')
 WHERE key = 'estate_name'
   AND value = 'EstateMate Estate';

UPDATE settings
   SET value = 'SE',
       updated_at = datetime('now')
 WHERE key = 'portal_short_name'
   AND value = 'EM';

-- New access-card numbers are decimal digits only.
--
-- Keep card_uid as TEXT: card numbers may start with zero, and converting them
-- to an integer would silently change the credential. Existing rows are left
-- untouched so historic cards remain visible and can still be disabled/deleted.
-- The triggers block only new card rows or a direct card_uid rewrite; unrelated
-- status/history updates on legacy rows continue to work.

CREATE TRIGGER access_cards_card_uid_digits_insert
BEFORE INSERT ON access_cards
WHEN NEW.card_uid IS NULL OR NEW.card_uid = '' OR NEW.card_uid GLOB '*[^0-9]*'
BEGIN
  SELECT RAISE(ABORT, 'card number may contain digits only');
END;

CREATE TRIGGER access_cards_card_uid_digits_update
BEFORE UPDATE OF card_uid ON access_cards
WHEN NEW.card_uid IS NULL OR NEW.card_uid = '' OR NEW.card_uid GLOB '*[^0-9]*'
BEGIN
  SELECT RAISE(ABORT, 'card number may contain digits only');
END;

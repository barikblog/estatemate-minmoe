# Street billing and historical CSV imports

## Property street data

Every new property requires a `street`. Street-targeted billing creates one bill for every active resident whose assigned property is on any selected street. A resident without an assigned property is not billed by a street batch.

The batch record stores the selected streets, amount, bill type, due date, description, creator, creation time, and number of generated bills.

## Existing bill import

Use **Bills & payments → Import CSV → Download template**.

Maximum: 500 data rows and 2 MB per upload.

Columns:

| Column | Required | Notes |
|---|---:|---|
| `external_reference` | Recommended | Unique ID from the old system; payment imports can refer to it. |
| `unit_number` | Conditional | Required when `resident_email` is empty. |
| `resident_email` | Conditional | Required when `unit_number` is empty; takes matching priority when both are supplied. |
| `amount` | Yes | Major units, e.g. `25000.00` NGN. |
| `currency` | No | Defaults to `NGN`. |
| `due_date` | Yes | ISO date such as `2026-12-31`. |
| `bill_type` | Yes | For example `facility_fee`, `levy`, `fine`. |
| `description` | No | Free text. |
| `status` | No | `unpaid`, `partial`, `paid`, or `void`; defaults to `unpaid`. |
| `created_at` | No | Original ISO date/time; defaults to import time. |

## Existing resident payment import

Import bills first when payments use old-system bill references.

| Column | Required | Notes |
|---|---:|---|
| `external_reference` | Recommended | Unique payment ID from the old system. |
| `bill_reference` | Yes | A bill's EstateMate UUID or imported `external_reference`. |
| `amount` | Yes | Major currency units. |
| `payment_method` | Yes | `cash`, `pos`, `bank_transfer`, or `online`. |
| `receipt_number` | Yes | Must be unique. |
| `status` | No | `pending`, `approved`, or `rejected`; defaults to `approved`. |
| `type` | No | `payment`, `refund`, or `adjustment`; defaults to `payment`. |
| `submitted_at` | No | Original ISO date/time; defaults to import time. |

Approved imported payments immediately recalculate the linked bill status.

## Error handling

Imports are row-tolerant: valid rows are saved while invalid rows are returned with their CSV row numbers. Every upload writes an `import_jobs` audit record with total, successful, and failed counts plus up to 100 error descriptions.

Duplicate external references or receipt numbers are rejected instead of overwriting existing financial records. There is no one-click rollback because later transactions may depend on imported bills. Correct errors in a new import or use audited adjustments rather than deleting financial history.

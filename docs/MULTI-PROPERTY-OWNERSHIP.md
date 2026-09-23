# Multi-property ownership

## Rules

- One active resident may own any number of properties.
- One property may have only one active owner.
- Every ownership must be assigned or approved by an administrator.
- Removing an owner does not delete the property, historical bills, payments, visitors, maintenance records, or audit entries.
- Legacy `users.property_id` values are migrated into approved ownerships and retained as a compatibility/default-property pointer.

## Resident workflow

A resident opens **My properties → Request another property** and chooses either:

1. **Existing unowned property** — select a unit already created by the administrator.
2. **Propose a new property** — provide the unit number, street, and address.

The request remains pending until an administrator approves or rejects it. A proposed property is not created until approval. The resident sees the request status and administrator review note.

## Administrator workflow

Administrators can:

- create or edit a property;
- assign an unowned property directly using the resident's email;
- approve or reject resident requests;
- remove the active owner while preserving historical records.

Approval of a proposed property creates the property and ownership together. Database indexes enforce the single-active-owner rule if two administrators attempt to approve conflicting requests.

## Billing and imports

Street billing joins properties to their active ownership records, so a resident owning three properties on a selected street receives one bill per property.

A bill CSV row may identify ownership by `unit_number`, `resident_email`, or both. When the resident owns more than one property, an email-only row is rejected as ambiguous and must include `unit_number`.

## Property-specific services

Visitor passes and maintenance requests now store the selected property. Residents with multiple properties must select the correct unit when creating either record. This keeps gate and maintenance records associated with the intended property.

## Related implemented workflows

Migration `0005` adds separate tenancies, dependants/household members, optional dependant logins, delegated visitor and bill permissions, effective-dated ownership transfers, downloadable property statements, and block/zone grouping. See [`TENANTS-DEPENDANTS-AND-TRANSFERS.md`](TENANTS-DEPENDANTS-AND-TRANSFERS.md).

Ownership requests and transfers now accept optional supporting proof stored in the configured private GitHub repository. The upload is linked to the approval record and remains available to authorized reviewers. See [`PROOF-UPLOADS-AND-PORTAL-CUSTOMISATION.md`](PROOF-UPLOADS-AND-PORTAL-CUSTOMISATION.md).

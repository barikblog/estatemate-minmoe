# Tenants, dependants, household access and ownership transfers

EstateMate keeps four concepts separate:

1. **Legal owner** — the resident recorded in active property ownership.
2. **Main resident** — the owner-occupant when there is no active tenancy, or the approved main tenant during a tenancy.
3. **Dependant/household member** — a spouse, child, parent, relative, domestic worker, caregiver or other person attached to the main resident and property.
4. **Bill payer** — the owner or tenant selected by the administrator for new property bills during a tenancy.

Separating these concepts prevents a tenancy from changing legal ownership and allows family or household access without incorrectly making every dependant a property owner.

## Rented apartments

### Tenant onboarding

- A legal owner may nominate an existing active resident account as tenant.
- An administrator may assign a tenant directly.
- Owner nominations remain pending until administrator approval.
- Only one active main tenancy is permitted per property.
- The tenancy records start date, optional end date, owner, tenant and billing responsibility.
- Future-start tenancies do not grant access or change billing until their start date.
- Expired tenancies are ended by the hourly lifecycle job.

The prospective tenant needs a Resident account. An administrator can create it under **People** before the owner submits the nomination.

### Billing responsibility

During approval the administrator selects:

- **Owner** — new grouped bills continue to go to the legal owner; or
- **Tenant** — new grouped bills go to the approved main tenant while the tenancy is active.

This choice applies to future street, block and zone bill batches. Existing bills remain linked to the original billed resident and are not moved automatically. Administrators can change the billing responsibility on an active tenancy without rewriting financial history.

Bill CSV imports use the current configured bill payer for the property. When an email alone could identify several properties, `unit_number` is still required.

### Ending a tenancy

An administrator ends the tenancy manually, or the hourly job ends it after its end date. Ending a tenancy:

- removes the tenant's active property relationship;
- returns future grouped billing responsibility to the owner;
- deactivates household members created under that tenant;
- preserves bills, payments, visitors, maintenance requests, gate history and audit records.

The legal owner's ownership is never removed merely because the apartment is rented.

## Dependants and household members

The main resident can submit:

- spouse;
- child;
- parent;
- relative;
- domestic staff;
- caregiver; or
- other household member.

Resident submissions require administrator approval. Administrators may add verified members directly.

### Profile-only member

This is the default and is suitable for children, domestic staff and people who do not need the portal. The member can receive an access card issued against the household-member record. The card remains financially tied to the main resident for facility-fee enforcement.

### Optional portal login

After approval, an administrator may link an existing Resident account or create a login with a temporary password. A linked dependant can see the property in EstateMate and may receive delegated permissions:

- **Create visitors** — allows visitor passes for that property.
- **View bills** — allows the dependant to view the main resident's property statement.

Dependants do not become owners and cannot nominate tenants or transfer ownership. A temporary password must be changed after first login.

### Access cards

When issuing a card, administrators can enter either:

- the main Resident ID; or
- the Household Member ID.

A dependant card displays the actual card holder but retains the main resident as the financially responsible resident. Deactivating a household member suspends active cards linked to that member and creates the normal hardware action for the terminal workflow.

## Ownership transfers

A legal owner or administrator can request transfer to another active Resident account. The request includes an effective date and requires administrator approval.

- Effective now or in the past: ownership changes immediately on approval.
- Future effective date: the transfer is scheduled and completed by the hourly lifecycle job.
- The previous ownership record is revoked but retained as history.
- Existing bills and payments remain with their original residents.
- An active tenancy remains attached to the property when ownership changes.
- Only one pending or scheduled transfer may exist for a property.

## Property statements

Authorized users can download a property statement as CSV from **Properties → Statement**.

- Administrators and cashiers can view the complete property statement.
- Legal owners can view the complete property statement.
- Main tenants can view bills assigned to them.
- Linked dependants can view the main resident's bills only when **View bills** is enabled.

Statements include each bill, billed resident, amount, approved payments, balance, due date and status.

## Zones and blocks

Properties can now have optional `zone` and `block` values in addition to street. Administrators and cashiers can generate grouped bills for selected:

- streets;
- blocks; or
- zones.

Each property is billed once per batch, and the current tenancy billing-responsibility rule determines the recipient.

## Audit and privacy

Tenancy approvals, household approvals, permission changes, login creation, access-card actions and ownership transfers are audit logged. No property or tenancy document upload was added in this phase, following the explicit decision to keep property files skipped.

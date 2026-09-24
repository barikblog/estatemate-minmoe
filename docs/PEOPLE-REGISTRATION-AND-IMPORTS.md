# People registration and bulk imports

## Single account registration

Administrators open **People → Add person** and provide the name, email, phone, role and a temporary password of at least 12 characters.

When the role is **Resident**, the property field lists only properties currently available in the portal—properties without an active approved owner. Selecting one creates the resident account and approved single-owner relationship together. The field is optional because a resident can request or receive property ownership later.

Security, Cashier, Manager and Administrator accounts cannot be assigned property ownership. Managers may manage Resident, Security and Cashier accounts but cannot create or change Administrator/Manager accounts.

## Editing and account lifecycle

Administrators can:

- edit name, email, phone, role and status;
- assign an additional available property to an existing resident;
- reset a password using a supplied temporary password or a generated one shown once;
- deactivate and reactivate an account;
- delete an account safely.

Delete is a soft delete: the account becomes inactive while billing, ownership, visitor, access and audit history remains. EstateMate blocks deactivation/deletion while the person has active property ownership or a pending/active tenancy. Transfer/remove ownership or close the tenancy first. Active cards are suspended and hardware disable operations are queued when an eligible account is deactivated.

An administrator cannot remove their own administrator access, and at least one active administrator must remain.

## Bulk user CSV

Use **People → Import users → Download template**. Up to 25 accounts are accepted per upload to stay within free Worker CPU and D1 request limits.

```csv
name,email,phone,role,unit_number,status
Ada Resident,ada@example.com,+2348000000000,resident,A-01,active
Gate Officer,security@example.com,+2348000000001,security,,active
```

Rules:

- Required columns: `name`, `email`, `role`.
- Roles: `resident`, `security`, `cashier`, `manager`, `admin`. A Manager upload cannot grant `manager` or `admin`; only an Administrator can.
- Status defaults to `active`; accepted values are `active` and `inactive`.
- `unit_number` is optional and valid only for an active resident.
- A unit must already exist and have no active owner.
- Duplicate emails, duplicate units within the CSV and already-owned properties are rejected per row.
- Passwords must not be put in the source CSV.

EstateMate generates a strong temporary password for every successfully created account. The response is displayed once and can be downloaded as a credentials CSV. Share it through a secure channel and require each user to change it after sign-in.

The source CSV is archived in the configured private GitHub storage repository and linked to import history. The archive contains no passwords and only an administrator can download it. Do not upload a user CSV until private storage is enabled and verified.

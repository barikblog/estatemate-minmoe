# Managers, operational imports and site synchronization

## Manager category

`manager` is an operational role below Administrator. It is intended for an estate manager who handles daily records without receiving financial, private-storage or global-configuration control.

Managers can:

- register and manage Resident, Security and Cashier accounts;
- assign properties, review ownership requests and process transfers;
- assign and end tenancies, manage household profiles and create dependant logins;
- manage maintenance, visitors and general estate notices;
- issue/suspend access cards and operate card-enrolment sessions;
- register/edit access-control devices and work the hardware-action queue;
- import users, properties, ownerships, tenancies and access cards.

Managers cannot:

- create, edit, reset, deactivate or delete Administrator or Manager accounts;
- grant Administrator or Manager privileges;
- manage bills, payments, storage credentials, portal-wide settings or device ingest-secret rotation;
- create temporary sample accounts.

All Manager actions continue to use the normal audit log and lifecycle safeguards.

## Operational Import Centre

The **Import centre** archives every accepted source CSV in the configured private GitHub repository before processing it. Administrator and Manager accounts can import up to 500 rows per operational file. Processing returns successful-row and error-row counts plus the first row errors in the portal.

Recommended order:

1. Properties
2. People
3. Property ownerships
4. Tenancies
5. Access cards
6. Bills and payments from the existing Billing import workflow

### Properties

Required: `unit_number,address,street`
Optional: `block,zone`

### Property ownerships

Required: `resident_email,unit_number`

The resident and property must already exist, the resident must be active, and the property must have no active owner.

### Tenancies

Required: `tenant_email,unit_number,start_date,billing_responsibility`
Optional: `end_date,status,can_manage_visitors,can_manage_maintenance,note`

`billing_responsibility` is `owner` or `tenant`. Status may be `pending`, `active`, `ended`, `rejected` or `cancelled`. A property needs an approved legal owner before a tenancy can be imported.

### Access cards

Required: `resident_email,card_uid`
Optional: `card_label,status,expires_at`

Active imported cards are placed into the existing device-operation synchronization queue.

## Retired integration

The Hik-Connect detail storage and the one-time ISUP site-sync installer were removed with the dedicated ISUP gateway transport (migration `0013_agent_only_transports.sql`). Managers now register devices and work the hardware-action queue; card provisioning runs through the ISAPI bridge agent. See [`ISAPI-BRIDGE-AND-WINDOWS-AGENT.md`](ISAPI-BRIDGE-AND-WINDOWS-AGENT.md).

## Sample logins

Only an Administrator can choose **Create 24-hour sample logins** in People. It creates one account for every category:

- Administrator
- Manager
- Resident
- Security
- Cashier

Strong temporary passwords are returned once as a downloadable CSV. Sample emails use the reserved `example.invalid` domain, the accounts automatically stop authenticating after 24 hours, and the hourly lifecycle task marks expired sample accounts inactive. Delete/deactivate them sooner after testing whenever possible.

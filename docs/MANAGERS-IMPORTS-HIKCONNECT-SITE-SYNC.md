# Managers, operational imports and site synchronization

## Manager category

`manager` is an operational role below Administrator. It is intended for an estate manager who handles daily records without receiving financial, private-storage or global-configuration control.

Managers can:

- register and manage Resident, Security and Cashier accounts;
- assign properties, review ownership requests and process transfers;
- assign and end tenancies, manage household profiles and create dependant logins;
- manage maintenance, visitors and general estate notices;
- issue/suspend access cards and operate card-enrolment sessions;
- register/edit access-control devices, download a site-sync installer and work the hardware-action queue;
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

## Hik-Connect details

An access-control device may store:

- access-server hostname or IP;
- Hik-Connect/device serial;
- verification code.

The verification code is AES-GCM encrypted with the configured storage encryption key (falling back to the Worker JWT key for existing installations), is never returned in device-list APIs, and is excluded from audit details. Entering a blank code during edit preserves the existing value.

These settings are configuration material, not proof of an available command API. Hik-Connect consumer registration details do not replace licensed Hikvision ISUP SDK integration or approved Hikvision OpenAPI credentials.

## Generated on-site synchronizer

For a device configured as **Dedicated ISUP gateway**, Administrator or Manager can choose **Download site sync**. EstateMate:

1. generates a separate one-time synchronization key;
2. stores only its peppered hash;
3. invalidates the prior generated site-sync key;
4. returns a no-cache Ubuntu shell installer once.

The installer clones the public EstateMate repository, installs the loopback-only gateway control plane, writes the device mapping and root-only Hik-Connect profile, and points it at the current EstateMate Worker. It deliberately does not pretend to supply Hikvision’s licensed SDK.

The estate must still install the official SDK adapter for the exact device/firmware and CPU architecture, configure `/etc/estatemate/isup-adapter.json`, and then start the gateway. Do not publish the generated script, verification code, ISUP key or device mapping.

## Sample logins

Only an Administrator can choose **Create 24-hour sample logins** in People. It creates one account for every category:

- Administrator
- Manager
- Resident
- Security
- Cashier

Strong temporary passwords are returned once as a downloadable CSV. Sample emails use the reserved `example.invalid` domain, the accounts automatically stop authenticating after 24 hours, and the hourly lifecycle task marks expired sample accounts inactive. Delete/deactivate them sooner after testing whenever possible.

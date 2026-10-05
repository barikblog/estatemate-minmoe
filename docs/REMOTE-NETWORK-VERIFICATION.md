# Remote Network Verification: the terminal reads, the bridge decides

An access terminal stores a few thousand people. A MinMoe is typically
1,500–3,000; the larger boxes are the same order. An estate with more humans than
that cannot fit them on the device, so synchronising the terminal's user list is
not a scale problem to optimise — it is a wall.

Remote Network Verification is the way past it: stop asking the terminal to
decide. It reports the credential it saw, **EstateMate Bridge** decides on the
LAN, and answers with the door command it already knows how to send.

## Where it fits

```text
Terminal (reader) ── event ──▶ EstateMate Bridge ── decision ──▶ RemoteControl/door
                                     ▲
                                     └── credential snapshot, refreshed on an interval
                                         (D1, over HTTPS — never on the hot path)
```

Two switches, and both must be on before anything opens:

1. **Per terminal**, in the portal: Access-control devices → the terminal →
   **Remote Network Verification**. Administrator-only.
2. **Per host**, in `agent-config.json`: `"remoteVerify": { "enabled": true }`.

Either one off and the terminal decides locally, exactly as it always has.

## Two ways the event arrives

| Path | How | When to use |
|---|---|---|
| **alertStream** (default) | The bridge holds an outbound `GET /ISAPI/Event/notification/alertStream` per terminal. No open port, no firewall rule, works on the Android bridge. | The default. Prefer it. |
| **LAN event listener** | The terminal POSTs each event to the bridge on a configured port (`lanEvents` in `agent-config.json`). | Terminals that can only push. |

The listener is the only place in the agent that accepts a connection, so it is
the most conservative code in the package: **off unless configured**, **bound to
loopback by default**, **ingest-only** (it never accepts an operation or a
command), and it prints the Windows firewall rule an operator needs when it is
bound to a LAN address. The installer does not create that rule for you:

```powershell
netsh advfirewall firewall add rule name="EstateMate LAN events" dir=in action=allow protocol=TCP localport=8080 profile=private
```

The Android bridge cannot host a listener at all — a phone on estate Wi-Fi is not
a stable address for a terminal to call — so it serves only terminals it can
reach with an outbound alertStream. That is a deliberate deviation from the
Node/Android equivalence rule, recorded here the way the ZKTeco PUSH one is.

## The decision is made from a local snapshot, not the database

This is the most important design choice in the feature.

The estate's 20,000+ users live in D1, which the bridge reaches over the public
internet. A lookup per swipe would make a physical door depend on the estate's
uplink, on Cloudflare, and on a round trip nobody can promise inside the few
hundred milliseconds a person stands at a reader — and it would fail **closed**,
which at a gate means a crowd.

So the bridge holds a local copy:

- **Full snapshot** on first sync, then **deltas** keyed on `since`.
- **Removals are part of the protocol.** A credential revoked between two syncs
  must leave the cache, or a card suspended an hour ago keeps opening the door
  until the next restart. Rows are kept for history (status flips, never
  deletes), which is what makes that list derivable.
- **Pages** are keyed by credential value, minimum 100 rows, so 20,000
  credentials arrive in a handful of requests rather than one enormous one.
- **A failed sync keeps the previous snapshot.** A list that is a few minutes
  stale still opens the right doors; an empty one opens none.
- **A cold cache denies.** An agent that has not yet loaded a snapshot must not
  decide that a stranger is a resident.

Lookups are a `Map` hit — microseconds — so the loop stays inside the time a
person is willing to stand at a reader, and it keeps working when the estate's
internet does not.

## What gets recorded

Every decision travels back with the event and lands in `access_events`:

| Field | Meaning |
|---|---|
| `remote_decision` | `granted` or `denied` |
| `remote_decision_reason` | `authorised`, `unknown_credential`, `credential_not_active`, `credential_expired`, `credential_not_yet_valid`, `not_allowed_at_this_gate`, `cache_not_ready`, `no_credential` |
| `remote_door_result` | `opened`, `refused`, `not_attempted` |

A denial is logged as **"Access Denied - Remote Database Lookup Failed"** with its
reason. The refusals matter as much as the grants: they are how you learn whether
a model honours the unlock command at all.

## The unlock command is best-effort, and that is not a formality

`PUT /ISAPI/AccessControl/RemoteControl/door/{n}` is sent JSON-first
(`{"RemoteControlDoor":{"cmd":"open"}}`), with the XML form
(`xmlns="http://www.isapi.org/ver20/XMLSchema" version="2.0"`) only when the
firmware does not implement the JSON URL. Note the namespace: the bare
`xmlns="http://isapi.org"` that appears in some examples is not what these
terminals accept.

**No device profile in `docs/device-profiles/` records a verified
RemoteControl/door response.** So:

- the command is fired, and the terminal's own answer is recorded verbatim;
- a refusal is surfaced in Gate activity and on the portal status widget, never
  retried into a lock and never assumed to have worked;
- until you have proved a model at one gate, keep the terminal's own local
  decision as the fallback.

## Installing it at a gate

1. Configure the terminal as a reader, and make sure it uploads **unknown-card
   events** — a card it does not hold produces no event at all otherwise.
2. Portal → the terminal → **Remote Network Verification**: on. Set the door
   number and the cooldown.
3. Bridge host → `agent-config.json`:
   ```json
   {
     "remoteVerify": { "enabled": true, "snapshotIntervalSeconds": 60, "pageSize": 2000 },
     "lanEvents": { "enabled": false, "port": 8080, "bindAddress": "127.0.0.1" }
   }
   ```
   Turn `lanEvents` on only if the terminal pushes. To accept pushes from the
   LAN, set `bindAddress` to the host's LAN address deliberately and add the
   firewall rule above.
4. Restart the bridge. Watch for `remote verification: N credential(s) cached` in
   the log; the portal widget shows the cache age and the last outcome.
5. **Prove it at one gate**, with the terminal's own menu as the fallback, before
   relying on it anywhere else.

## Cooldown, and why it exists

A card left resting on a reader, or a person presenting twice because the door
did not move, produces a burst of identical events. Without a cooldown each one
fires another unlock command — noisy for the lock, and a way to hold a door open
by leaving a card in place. The default is 1500 ms per credential, per terminal,
configurable per terminal in the portal.

## Card numbers are the usual cause of "it does not work"

Hikvision reports the same physical card in different shapes depending on the
terminal's card format and firmware: raw decimal, zero-padded to ten digits, and
(some Wiegand configurations) a byte-reversed hexadecimal. A card enrolled by
tapping matches exactly, but one typed from a CSV or read by a differently
configured reader often does not.

The cache probes each known form in turn. If a specific estate needs another,
add it to `remoteVerify.cardNumberFormats` — never to the stored card number.

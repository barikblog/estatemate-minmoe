# Device profiles

Add one Markdown file per tested model and firmware build. Include exact UI labels, ISAPI alertStream availability and payload shape, example redacted payloads, access minor-code mappings, offline retry behavior, certificate behavior, time-zone behavior, and whether the ISAPI card command APIs work on the firmware.

One file is not a model: [`ZKTECO-PUSH.md`](./ZKTECO-PUSH.md) records a
**transport** (the ZKTeco PUSH/ADMS protocol EstateMate's agent serves) rather than
a tested board, because the load-bearing limits there — the numeric User ID rule and
what the protocol refuses to do — come from the protocol and from EstateMate's
identity rules. It does not substitute for the per-model files above, and it says so
at the top.

Naming example:

`DS-K1T341AMF_V3-x-x_build-YYYYMMDD.md`

Never commit serial numbers, device passwords, public IPs, faces, fingerprint templates, resident names, or live card numbers.

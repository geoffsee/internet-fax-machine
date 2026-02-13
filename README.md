# Internet Fax Worker (Cloudflare)

Pluggable fax webhook + media gateway that runs on Cloudflare Workers. The worker stores fax PDFs in KV, serves them back to the fax provider, and handles status/inbound webhooks. Providers are swappable via `FAX_PROVIDER`; Telnyx, Dropbox Fax, and Sinch are built in.

## Features

- HTTP API to upload media and send faxes (`/media/:key`, `/fax/send`)
- Stores PDF payloads in KV and serves them with correct content type
- Basic auth (optional) to protect send/upload endpoints
- Provider abstraction (`FaxProvider`) so additional fax vendors can be added quickly
- Tested with Bun (`bun test`)

## Architecture

```
Client / CLI               Cloudflare Worker                  Fax Provider
─────────────             ──────────────────                ───────────────
1. PUT /media/:key ───────▶ KV (PDF storage)
2. POST /fax/send ────────▶ provider.sendFax()
                                                     (provider API sends fax)
3.                               POST /<provider webhook> ◀─┘ status/inbound
4.                               GET  /media/:key        ◀─┘ provider fetches PDF
```

Inbound fax: provider posts a `fax.received`-style webhook with `media_url`; worker downloads PDF and stores in KV.

## Providers

- `telnyx` (default) — Telnyx Programmable Fax. Webhook: `/telnyx/fax-rx`.
- `dropbox-fax` — Dropbox Sign / HelloFax fax API. Webhook: `/dropbox/fax-rx`.
- `sinch` — Sinch Fax API. Webhook: `/sinch/fax-rx`.
- To add more, implement `FaxProvider` (see `src/providers/types.ts`) and register it in `resolveProvider` inside `src/worker.ts`.

## Prerequisites

- Bun ≥ 1.0
- Cloudflare account + KV namespace
- Provider account (Telnyx for now)
- Wrangler CLI (`npm i -g wrangler`), `bun install`

## Configuration

| Key                                     | Where  | Purpose                                                               |
| --------------------------------------- | ------ | --------------------------------------------------------------------- |
| `FAX_PROVIDER`                          | vars   | Provider name (`telnyx` default; also `dropbox-fax`, `sinch`)         |
| `FAX_FROM`                              | vars   | Outbound caller ID / fax number (E.164) where supported               |
| `TELNYX_API_KEY`                        | secret | Telnyx API key                                                        |
| `CONNECTION_ID`                         | vars   | Telnyx fax application ID                                             |
| `DROPBOX_SIGN_API_KEY`                  | secret | Dropbox Sign API key (Basic auth user; password blank)                |
| `DROPBOX_FAX_TEST_MODE`                 | vars   | `"1"` (default) to send in test mode; set to `"0"` to send real faxes |
| `SINCH_PROJECT_ID`                      | vars   | Sinch project ID                                                      |
| `SINCH_ACCESS_KEY` / `SINCH_SECRET_KEY` | secret | Sinch Fax API credentials (Basic auth)                                |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`   | secret | Optional: protect `/fax/send` and `/media/:key` (PUT)                 |

Reference files: `.env.example.server`, `wrangler.toml`.

## Telnyx setup (one-time)

1. Buy a fax-enabled number.
2. Create a Fax Application:

```bash
curl -X POST https://api.telnyx.com/v2/fax_applications \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "application_name": "fax-worker",
    "webhook_event_url": "https://YOUR-WORKER.workers.dev/telnyx/fax-rx",
    "inbound": { "channel_limit": 10, "sip_subdomain_receive_settings": "from_anyone" },
    "outbound": { "channel_limit": 10 }
  }'
```

3. Create an Outbound Voice Profile and attach it:

```bash
curl -X POST https://api.telnyx.com/v2/outbound_voice_profiles \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "fax-outbound", "traffic_type": "conversational", "service_plan": "global"}'

curl -X PATCH https://api.telnyx.com/v2/fax_applications/<fax_application_id> \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"outbound": {"outbound_voice_profile_id": "<outbound_voice_profile_id>"}}'
```

4. Assign your number to the fax application:

```bash
curl -X PATCH https://api.telnyx.com/v2/phone_numbers/+1XXXXXXXXXX \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connection_id": "<fax_application_id>"}'
```

## Dropbox Fax setup (HelloFax / Dropbox Sign)

1. Create an API key in the Dropbox Sign admin console (Webhooks must be enabled for Fax).
2. Set `DROPBOX_SIGN_API_KEY` as a secret and `FAX_PROVIDER=dropbox-fax`.
3. Configure your Dropbox Sign fax webhook to `https://YOUR-WORKER.workers.dev/dropbox/fax-rx`.
4. Keep `DROPBOX_FAX_TEST_MODE=1` for sandboxing; set to `0` to send real faxes.

## Sinch setup

1. In the Sinch dashboard, create / locate your Fax project and note `SINCH_PROJECT_ID`.
2. Generate an access key + secret; store as secrets `SINCH_ACCESS_KEY` and `SINCH_SECRET_KEY`.
3. Set `FAX_PROVIDER=sinch` and `FAX_FROM` to a Sinch fax-enabled number if required.
4. Point the inbound webhook to `https://YOUR-WORKER.workers.dev/sinch/fax-rx`.

## Deploy

```bash
bun install
wrangler secret put TELNYX_API_KEY
wrangler secret put DROPBOX_SIGN_API_KEY        # optional, for dropbox-fax
wrangler secret put SINCH_ACCESS_KEY            # optional, for sinch
wrangler secret put SINCH_SECRET_KEY            # optional, for sinch
wrangler secret put BASIC_AUTH_USER  # optional
wrangler secret put BASIC_AUTH_PASS  # optional
wrangler deploy
```

## Usage

### HTTP API

- `PUT /media/:key` (auth required if basic auth configured) — store PDF in KV. Body: raw bytes; `Content-Type: application/pdf`.
- `GET /media/:key` — serve stored PDF (no auth).
- `POST /fax/send` (auth required if configured)
  - Multipart: fields `to`, file `file` (PDF).
  - JSON: `{ "to": "+15551234567", "media_key": "file.pdf" }` (media must already be in KV).
- Webhook path: provider-specific (Telnyx `/telnyx/fax-rx`, Dropbox Fax `/dropbox/fax-rx`, Sinch `/sinch/fax-rx`). Must be reachable publicly.

### Client library (TypeScript)

```ts
import { FaxWorkerClient } from "./lib";
import { readFileSync } from "fs";

const client = new FaxWorkerClient({
  workerUrl: "https://YOUR-WORKER.workers.dev",
});
const pdf = readFileSync("document.pdf");
await client.uploadAndSendFax("+15551234567", pdf, "document.pdf");
```

### CLI helper

```bash
cp .env.example.client .env && edit .env
export $(cat .env | xargs) && bun run send-test-fax.ts
# or: bun run send (package script)
```

### Monitor logs

```bash
wrangler tail --format pretty
```

### Run tests

```bash
bun test
```

## Flows

**Sending:** upload PDF → POST `/fax/send` → worker calls provider send API → provider fetches PDF from `/media/:key` → status webhooks to provider path.  
**Receiving:** provider webhook includes `media_url` → worker downloads PDF using provider auth → stores in KV (`telnyx:fax:<id>.pdf`) → responds 200.

## Extending to a new provider

1. Create `src/providers/<name>.ts` implementing `FaxProvider`.
2. Register it in `resolveProvider` inside `src/worker.ts`.
3. Set `FAX_PROVIDER=<name>` in `wrangler.toml` or env.
4. Deploy; point the provider webhook to the new `webhookPath`.

## Example values

| Item                      | Example                         |
| ------------------------- | ------------------------------- |
| Worker URL                | https://your-worker.workers.dev |
| KV namespace              | YOUR_KV_NAMESPACE_ID            |
| Telnyx number             | +15551234567                    |
| Fax application ID        | YOUR_FAX_APPLICATION_ID         |
| Outbound voice profile ID | YOUR_OUTBOUND_VOICE_PROFILE_ID  |

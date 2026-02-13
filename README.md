# Telnyx Fax Worker

Send and receive faxes via [Telnyx Programmable Fax](https://telnyx.com/products/programmable-fax) + a Cloudflare Worker for webhooks and media storage.

## Architecture

```
send-test-fax.ts                  Cloudflare Worker                  Telnyx
─────────────────                ──────────────────                ──────────
1. Upload PDF ──PUT /media/:key──▶ KV (media storage)
2. Send fax ──────────────────────────────────────────▶ faxes.create()
                                                        │
3.                                POST /telnyx/fax-rx ◀─┘  (status webhooks)
4.                                GET  /media/:key    ◀─┘  (Telnyx fetches PDF)
```

**Inbound faxes** follow the reverse path: Telnyx receives the fax and POSTs a `fax.received` webhook with a `media_url`. The worker downloads the PDF and stores it in KV.

## Files

| File | Purpose |
|---|---|
| `lib.ts` | TypeScript client library for interacting with the worker API |
| `send-test-fax.ts` | CLI script — example usage of the client library |
| `worker.ts` | Cloudflare Worker — media storage + fax webhooks |
| `wrangler.toml` | Worker deployment config |
| `.env.example.client` | Example environment variables for CLI usage |
| `.env.example.server` | Example environment variables for worker configuration |

## Setup

### 1. Telnyx account

- Buy a fax-enabled phone number
- Create a **Fax Application** (not a voice/credential connection) via the API:
  ```bash
  curl -X POST https://api.telnyx.com/v2/fax_applications \
    -H "Authorization: Bearer $TELNYX_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "application_name": "fax-worker",
      "webhook_event_url": "https://YOUR-WORKER-NAME.workers.dev/telnyx/fax-rx",
      "inbound": { "channel_limit": 10, "sip_subdomain_receive_settings": "from_anyone" },
      "outbound": { "channel_limit": 10 }
    }'
  ```
- Create an **Outbound Voice Profile** (required for sending faxes):
  ```bash
  curl -X POST https://api.telnyx.com/v2/outbound_voice_profiles \
    -H "Authorization: Bearer $TELNYX_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"name": "fax-outbound", "traffic_type": "conversational", "service_plan": "global"}'
  ```
- Attach the outbound voice profile to the fax application:
  ```bash
  curl -X PATCH https://api.telnyx.com/v2/fax_applications/<fax_application_id> \
    -H "Authorization: Bearer $TELNYX_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"outbound": {"outbound_voice_profile_id": "<outbound_voice_profile_id>"}}'
  ```
- Assign the phone number to the fax application:
  ```bash
  curl -X PATCH https://api.telnyx.com/v2/phone_numbers/+1XXXXXXXXXX \
    -H "Authorization: Bearer $TELNYX_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"connection_id": "<fax_application_id>"}'
  ```

### 2. Configure worker

Update `wrangler.toml` with your configuration:
- `CONNECTION_ID` - Your Telnyx fax application ID
- `FAX_FROM` - Your Telnyx fax-enabled phone number

Set worker secrets:

```bash
# Required: Telnyx API key
npx wrangler secret put TELNYX_API_KEY

# Optional but recommended: Basic auth credentials
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASS
```

**Note:** Basic auth protects the upload and send endpoints. If you don't set `BASIC_AUTH_USER` and `BASIC_AUTH_PASS`, the worker will be publicly accessible.

See `.env.example.server` for reference.

### 3. Install and deploy

```bash
bun install
npx wrangler deploy
```

## Usage

### Using the client library

```typescript
import { FaxWorkerClient } from "./lib";
import { readFileSync } from "fs";

const client = new FaxWorkerClient({
    workerUrl: "https://YOUR-WORKER-NAME.workers.dev",
    username: "your-username",  // Optional: if basic auth is enabled
    password: "your-password"   // Optional: if basic auth is enabled
});

// Upload a file and send a fax
const fileBuffer = readFileSync("document.pdf");
const result = await client.uploadAndSendFax("+15551234567", fileBuffer, "document.pdf");

// Or send using an already-uploaded media key
await client.sendFax("+15551234567", "existing-file.pdf");

// Or upload a file directly with the fax request (multipart)
await client.sendFaxWithFile("+15551234567", fileBuffer, "document.pdf");
```

### Send a fax via CLI

Create a `.env` file based on `.env.example.client`:

```bash
cp .env.example.client .env
# Edit .env with your values
```

Then run:

```bash
export $(cat .env | xargs) && bun run send-test-fax.ts
```

Or pass env vars directly:

```bash
FAX_TO=+15551234567 FAX_FILE=./my-doc.pdf WORKER_URL=https://your-worker.workers.dev bun run send-test-fax.ts
```

### Send a fax via the worker API

**Multipart (upload PDF inline):**

```bash
curl -X POST https://YOUR-WORKER-NAME.workers.dev/fax/send \
  -u username:password \
  -F to="+15551234567" \
  -F file=@document.pdf
```

**JSON (reference an already-uploaded media key):**

```bash
curl -X POST https://YOUR-WORKER-NAME.workers.dev/fax/send \
  -u username:password \
  -H "Content-Type: application/json" \
  -d '{"to": "+15551234567", "media_key": "dist-page1.pdf"}'
```

**Note:** The `-u username:password` flag is only needed if basic auth is enabled on the worker.

The worker stores the PDF in KV, passes the public URL to Telnyx, and returns the fax object. `CONNECTION_ID`, `FAX_FROM`, and `TELNYX_API_KEY` are configured on the worker (see wrangler.toml and secrets).

### Worker endpoints

| Method | Path | Auth Required | Description |
|---|---|---|---|
| `POST` | `/fax/send` | ✅ Yes | Send a fax. Accepts multipart (`file` + `to`) or JSON (`media_key` + `to`). |
| `PUT` | `/media/:key` | ✅ Yes | Upload a file to KV. Returns `{ mediaUrl }`. |
| `GET` | `/media/:key` | ❌ No | Serve a file from KV. Used by Telnyx to fetch the PDF. |
| `POST` | `/telnyx/fax-rx` | ❌ No | Telnyx webhook receiver. Handles all fax events. |

### Monitor logs

```bash
npx wrangler tail --format pretty
```

## How sending works

1. Client uploads PDF to the worker via `PUT /media/<filename>` (stored in Cloudflare KV)
2. Client calls `POST /fax/send` with the destination number and media key
3. Worker calls Telnyx API to send the fax, passing the public `media_url` pointing back to the worker
4. Telnyx fetches the PDF from `GET /media/<filename>`, converts to TIFF, and sends via T.38
5. Status webhooks (`fax.queued`, `fax.sending.started`, `fax.delivered` or `fax.failed`) POST to `/telnyx/fax-rx`

## How receiving works

1. Telnyx receives an inbound fax on your number
2. Telnyx POSTs a `fax.received` event to `/telnyx/fax-rx` with a `media_url`
3. The worker downloads the PDF from Telnyx (authenticated with `TELNYX_API_KEY`)
4. Stores the PDF in KV under `telnyx:fax:<fax_id>.pdf`

## Example config

| Resource | Value |
|---|---|
| Telnyx number | +15551234567 |
| Fax application ID | YOUR_FAX_APPLICATION_ID |
| Outbound voice profile ID | YOUR_OUTBOUND_VOICE_PROFILE_ID |
| Worker URL | https://YOUR-WORKER-NAME.workers.dev |
| KV namespace | YOUR_KV_NAMESPACE_ID |

## Telnyx webhook events

| Event | When |
|---|---|
| `fax.queued` | Fax accepted and queued for sending |
| `fax.media.processed` | PDF converted to TIFF successfully |
| `fax.sending.started` | T.38 transmission started |
| `fax.delivered` | Fax delivered successfully |
| `fax.failed` | Fax failed (check `failure_reason`) |
| `fax.received` | Inbound fax received (includes `media_url`) |

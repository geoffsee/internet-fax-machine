/**
 * Telnyx fax receive webhook endpoint (Cloudflare Worker)
 *
 * Telnyx sends webhook events for inbound faxes as JSON POSTs.
 * Event types:
 *   - fax.received    — inbound fax completed, includes media_url
 *   - fax.sending      — outbound fax in progress
 *   - fax.sent         — outbound fax completed
 *   - fax.failed       — fax failed
 *
 * This worker:
 *   1. Accepts POST /telnyx/fax-rx
 *   2. Parses the Telnyx webhook JSON payload
 *   3. On fax.received: downloads the PDF from media_url, stores in KV
 *   4. Returns 200 to acknowledge
 */

type Env = {
    KV: KVNamespace;
    TELNYX_API_KEY?: string;
    CONNECTION_ID?: string;
    FAX_FROM?: string;
    BASIC_AUTH_USER?: string;
    BASIC_AUTH_PASS?: string;
};

export default {
    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const requestId = crypto.randomUUID();
        const url = new URL(req.url);

        // Check basic auth for protected endpoints
        const isProtectedEndpoint =
            (url.pathname.startsWith("/media/") && req.method === "PUT") ||
            (url.pathname === "/fax/send" && req.method === "POST");

        if (isProtectedEndpoint) {
            const authResult = checkBasicAuth(req, env);
            if (!authResult.authorized) {
                return new Response("Unauthorized", {
                    status: 401,
                    headers: { "WWW-Authenticate": 'Basic realm="Fax Worker"' },
                });
            }
        }

        // PUT /media/:key — upload a file to KV
        if (url.pathname.startsWith("/media/") && req.method === "PUT") {
            const key = decodeURIComponent(url.pathname.slice("/media/".length));
            if (!key) return new Response("Missing key", { status: 400 });
            const bytes = await req.arrayBuffer();
            const contentType = req.headers.get("content-type") || "application/octet-stream";
            await env.KV.put(`media:${key}`, bytes, { metadata: { contentType } });
            const mediaUrl = `${url.origin}/media/${encodeURIComponent(key)}`;
            log(requestId, "media uploaded", { key, bytes: bytes.byteLength, mediaUrl });
            return new Response(JSON.stringify({ ok: true, key, mediaUrl, bytes: bytes.byteLength }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }

        // GET /media/:key — serve a file from KV
        if (url.pathname.startsWith("/media/") && req.method === "GET") {
            const key = decodeURIComponent(url.pathname.slice("/media/".length));
            const { value, metadata } = await env.KV.getWithMetadata<{ contentType?: string }>(
                `media:${key}`,
                "arrayBuffer",
            );
            if (!value) return new Response("Not found", { status: 404 });
            return new Response(value, {
                headers: { "content-type": metadata?.contentType || "application/octet-stream" },
            });
        }

        // POST /fax/send — send a fax
        // Body: multipart/form-data with "file" (PDF) and "to" field
        //   or: application/json with "to" and "media_key" (existing KV media key)
        if (url.pathname === "/fax/send" && req.method === "POST") {
            if (!env.TELNYX_API_KEY) return json({ ok: false, error: "TELNYX_API_KEY not configured" }, 500);
            if (!env.CONNECTION_ID) return json({ ok: false, error: "CONNECTION_ID not configured" }, 500);
            if (!env.FAX_FROM) return json({ ok: false, error: "FAX_FROM not configured" }, 500);

            const contentType = req.headers.get("content-type") || "";
            let to: string;
            let mediaUrl: string;

            if (contentType.includes("multipart/form-data")) {
                const form = await req.formData();
                to = form.get("to") as string;
                if (!to) return json({ ok: false, error: "missing 'to' field" }, 400);

                const file = form.get("file") as File | null;
                if (!file) return json({ ok: false, error: "missing 'file' field" }, 400);

                const key = `fax-out-${requestId}-${file.name}`;
                const bytes = await file.arrayBuffer();
                await env.KV.put(`media:${key}`, bytes, {
                    metadata: { contentType: file.type || "application/pdf" },
                });
                mediaUrl = `${url.origin}/media/${encodeURIComponent(key)}`;
                log(requestId, "uploaded outbound fax media", { key, bytes: bytes.byteLength });
            } else {
                const body = (await req.json()) as { to?: string; media_key?: string };
                to = body.to ?? "";
                if (!to) return json({ ok: false, error: "missing 'to' field" }, 400);
                if (!body.media_key) return json({ ok: false, error: "missing 'media_key' field" }, 400);
                mediaUrl = `${url.origin}/media/${encodeURIComponent(body.media_key)}`;
            }

            log(requestId, "sending fax", { to, from: env.FAX_FROM, mediaUrl });

            const telnyxRes = await fetch("https://api.telnyx.com/v2/faxes", {
                method: "POST",
                headers: {
                    authorization: `Bearer ${env.TELNYX_API_KEY}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    connection_id: env.CONNECTION_ID,
                    from: env.FAX_FROM,
                    to,
                    media_url: mediaUrl,
                    quality: "high",
                    t38_enabled: true,
                    webhook_url: `${url.origin}/telnyx/fax-rx`,
                }),
            });

            const telnyxBody = await telnyxRes.json();
            log(requestId, "telnyx fax response", { status: telnyxRes.status, body: telnyxBody });

            return json({ ok: telnyxRes.ok, requestId, fax: telnyxBody }, telnyxRes.status);
        }

        if (url.pathname !== "/telnyx/fax-rx") return new Response("Not found", { status: 404 });
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

        try {
            const event = (await req.json()) as TelnyxWebhookEvent;
            const eventType = event.data?.event_type ?? "unknown";
            const faxId = event.data?.payload?.fax_id ?? requestId;

            log(requestId, "telnyx fax webhook", {
                eventType,
                faxId,
                from: event.data?.payload?.from,
                to: event.data?.payload?.to,
                direction: event.data?.payload?.direction,
                status: event.data?.payload?.status,
                pageCount: event.data?.payload?.page_count,
            });

            if (eventType === "fax.received") {
                const mediaUrl = event.data?.payload?.media_url;

                if (mediaUrl) {
                    log(requestId, "downloading fax media", { mediaUrl: mediaUrl.slice(0, 120) });

                    const headers: Record<string, string> = {};
                    if (env.TELNYX_API_KEY) {
                        headers.authorization = `Bearer ${env.TELNYX_API_KEY}`;
                    }

                    const mediaRes = await fetch(mediaUrl, { method: "GET", headers });
                    const mediaBytes = await mediaRes.arrayBuffer();

                    const kvKey = `telnyx:fax:${faxId}.pdf`;
                    await env.KV.put(kvKey, mediaBytes);

                    log(requestId, "stored fax media in kv", {
                        kvKey,
                        bytes: mediaBytes.byteLength,
                    });
                } else {
                    log(requestId, "fax.received but no media_url");
                    await env.KV.put(
                        `telnyx:fax:${faxId}:meta.json`,
                        JSON.stringify(event.data?.payload),
                    );
                }
            } else {
                log(requestId, `event ${eventType} — storing metadata`);
                await env.KV.put(
                    `telnyx:fax:${faxId}:${eventType}.json`,
                    JSON.stringify(event.data?.payload),
                );
            }

            return new Response(JSON.stringify({ ok: true, requestId }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        } catch (err) {
            log(requestId, "ERROR", {
                message: err instanceof Error ? err.message : String(err),
            });
            return new Response(JSON.stringify({ ok: false, requestId, error: String(err) }), {
                status: 500,
                headers: { "content-type": "application/json" },
            });
        }
    },
};

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function log(requestId: string, message: string, meta?: unknown) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), requestId, message, meta }));
}

function checkBasicAuth(req: Request, env: Env): { authorized: boolean; user?: string } {
    // If no auth configured, allow all requests
    if (!env.BASIC_AUTH_USER || !env.BASIC_AUTH_PASS) {
        return { authorized: true };
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Basic ")) {
        return { authorized: false };
    }

    try {
        const base64Credentials = authHeader.slice(6);
        const credentials = atob(base64Credentials);
        const [user, pass] = credentials.split(":");

        if (user === env.BASIC_AUTH_USER && pass === env.BASIC_AUTH_PASS) {
            return { authorized: true, user };
        }
    } catch (err) {
        return { authorized: false };
    }

    return { authorized: false };
}

// ── Telnyx webhook types ──

interface TelnyxWebhookEvent {
    data?: {
        event_type?: string;
        id?: string;
        payload?: {
            fax_id?: string;
            direction?: string;
            from?: string;
            to?: string;
            status?: string;
            media_url?: string;
            page_count?: number;
            quality?: string;
            connection_id?: string;
            [key: string]: unknown;
        };
    };
}

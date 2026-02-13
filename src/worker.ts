/**
 * Fax worker with pluggable providers (defaults to Telnyx).
 */

import { FaxProvider, ProviderContext, WorkerEnv } from "./providers/types";
import { TelnyxProvider } from "./providers/telnyx";

export default {
    async fetch(req: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
        const requestId = crypto.randomUUID();
        const url = new URL(req.url);

        const providerResult = resolveProvider(env);
        if (!providerResult.ok) {
            return json({ ok: false, error: providerResult.error, requestId }, 500);
        }
        const provider = providerResult.provider;

        const baseUrl = url.origin;
        const providerCtx: ProviderContext = {
            requestId,
            baseUrl,
            env,
            kv: env.KV,
            log,
        };

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

            const sendResult = await provider.sendFax({ to, mediaUrl }, providerCtx);
            return json({ ok: sendResult.ok, requestId, fax: sendResult.fax }, sendResult.status);
        }

        // Provider webhook endpoint
        if (url.pathname === provider.webhookPath) {
            if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
            return provider.handleWebhook(req, providerCtx);
        }

        return new Response("Not found", { status: 404 });
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

function checkBasicAuth(req: Request, env: WorkerEnv): { authorized: boolean; user?: string } {
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

function resolveProvider(env: WorkerEnv): { ok: true; provider: FaxProvider } | { ok: false; error: string } {
    const name = (env.FAX_PROVIDER ?? "telnyx").toLowerCase();
    switch (name) {
        case "telnyx":
            return { ok: true, provider: TelnyxProvider };
        default:
            return { ok: false, error: `Unsupported fax provider: ${name}` };
    }
}

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TelnyxProvider } from "./telnyx";
import type { ProviderContext, WorkerEnv } from "./types";

class KVStub implements KVNamespace {
  puts: Array<{ key: string; value: unknown; options?: unknown }> = [];

  async put(key: string, value: unknown, options?: unknown): Promise<void> {
    this.puts.push({ key, value, options });
  }

  // Minimal stub to satisfy interface; not used in tests
  async getWithMetadata<_M = unknown>(
    _key: string,
    _type: "text" | "json" | "arrayBuffer" | "stream" = "text",
  ): Promise<{ value: unknown; metadata: unknown | null }> {
    return { value: null, metadata: null };
  }
}

describe("TelnyxProvider.sendFax", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts fax payload to Telnyx with required fields", async () => {
    const captured: { url?: string; body?: any; headers?: any } = {};

    globalThis.fetch = async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.url = url.toString();
      captured.headers = init?.headers;
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ data: { id: "fax_123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const env: WorkerEnv = {
      KV: new KVStub(),
      TELNYX_API_KEY: "key_123",
      CONNECTION_ID: "conn_123",
      FAX_FROM: "+15551234567",
    };

    const ctx: ProviderContext = {
      requestId: "req-1",
      baseUrl: "https://worker.example",
      env,
      kv: env.KV,
      log: () => {},
    };

    const result = await TelnyxProvider.sendFax(
      { to: "+15558675309", mediaUrl: "https://worker.example/media/file.pdf" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(captured.url).toBe("https://api.telnyx.com/v2/faxes");
    expect(captured.headers?.authorization).toBe("Bearer key_123");
    expect(captured.body.connection_id).toBe("conn_123");
    expect(captured.body.from).toBe("+15551234567");
    expect(captured.body.to).toBe("+15558675309");
    expect(captured.body.media_url).toBe(
      "https://worker.example/media/file.pdf",
    );
    expect(captured.body.webhook_url).toBe(
      "https://worker.example/telnyx/fax-rx",
    );
  });

  it("returns error when required env is missing", async () => {
    const env: WorkerEnv = {
      KV: new KVStub(),
      CONNECTION_ID: "conn_123",
      FAX_FROM: "+15551234567",
      // TELNYX_API_KEY missing
    };

    const ctx: ProviderContext = {
      requestId: "req-2",
      baseUrl: "https://worker.example",
      env,
      kv: env.KV,
      log: () => {},
    };

    const result = await TelnyxProvider.sendFax(
      { to: "+15558675309", mediaUrl: "https://worker.example/media/file.pdf" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

describe("TelnyxProvider.handleWebhook", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("stores received fax media into KV", async () => {
    const kv = new KVStub();
    const env: WorkerEnv = { KV: kv, TELNYX_API_KEY: "key_123" };
    const ctx: ProviderContext = {
      requestId: "req-3",
      baseUrl: "https://worker.example",
      env,
      kv,
      log: () => {},
    };

    const fakePdf = new Uint8Array([1, 2, 3]).buffer;

    globalThis.fetch = async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      expect(init?.headers && (init.headers as any).authorization).toBe(
        "Bearer key_123",
      );
      return new Response(fakePdf, { status: 200 });
    };

    const webhookEvent = {
      data: {
        event_type: "fax.received",
        payload: {
          fax_id: "fax_999",
          media_url: "https://files.telnyx.com/fax.pdf",
        },
      },
    };

    const req = new Request("https://worker.example/telnyx/fax-rx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(webhookEvent),
    });

    const res = await TelnyxProvider.handleWebhook(req, ctx);

    expect(res.status).toBe(200);
    expect(kv.puts.length).toBe(1);
    expect(kv.puts[0].key).toBe("telnyx:fax:fax_999.pdf");
    expect((kv.puts[0].value as ArrayBuffer).byteLength).toBe(3);
  });

  it("stores metadata for non-media events", async () => {
    const kv = new KVStub();
    const env: WorkerEnv = { KV: kv };
    const ctx: ProviderContext = {
      requestId: "req-4",
      baseUrl: "https://worker.example",
      env,
      kv,
      log: () => {},
    };

    const webhookEvent = {
      data: {
        event_type: "fax.queued",
        payload: {
          fax_id: "fax_123",
          status: "queued",
        },
      },
    };

    const req = new Request("https://worker.example/telnyx/fax-rx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(webhookEvent),
    });

    const res = await TelnyxProvider.handleWebhook(req, ctx);

    expect(res.status).toBe(200);
    expect(kv.puts.length).toBe(1);
    expect(kv.puts[0].key).toBe("telnyx:fax:fax_123:fax.queued.json");
    expect(typeof kv.puts[0].value).toBe("string");
  });
});

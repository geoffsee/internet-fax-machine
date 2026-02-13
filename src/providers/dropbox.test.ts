import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DropboxFaxProvider } from "./dropbox";
import type { ProviderContext, WorkerEnv } from "./types";

class KVStub implements KVNamespace {
  puts: Array<{ key: string; value: unknown; options?: unknown }> = [];

  async put(key: string, value: unknown, options?: unknown): Promise<void> {
    this.puts.push({ key, value, options });
  }

  async getWithMetadata<_M = unknown>(
    _key: string,
    _type: "text" | "json" | "arrayBuffer" | "stream" = "text",
  ): Promise<{ value: unknown; metadata: unknown | null }> {
    return { value: null, metadata: null };
  }
}

describe("DropboxFaxProvider.sendFax", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends fax payload with file_urls and proper auth", async () => {
    const captured: { url?: string; headers?: any; body?: any } = {};

    globalThis.fetch = async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.url = url.toString();
      captured.headers = init?.headers;
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ fax_id: "fax_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const env: WorkerEnv = {
      KV: new KVStub(),
      DROPBOX_SIGN_API_KEY: "dbx_key",
      FAX_FROM: "+15551234567",
      DROPBOX_FAX_TEST_MODE: "0",
    };

    const ctx: ProviderContext = {
      requestId: "req-1",
      baseUrl: "https://worker.example",
      env,
      kv: env.KV,
      log: () => {},
    };

    const result = await DropboxFaxProvider.sendFax(
      { to: "+15558675309", mediaUrl: "https://worker.example/media/file.pdf" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(captured.url).toBe("https://api.hellosign.com/v3/fax/send");
    expect(captured.headers?.authorization).toBe("Basic " + btoa("dbx_key:"));
    expect(captured.body.file_urls[0]).toBe(
      "https://worker.example/media/file.pdf",
    );
    expect(captured.body.test_mode).toBe(false);
    expect(captured.body.sender).toBe("+15551234567");
  });

  it("returns error when api key is missing", async () => {
    const env: WorkerEnv = { KV: new KVStub() };
    const ctx: ProviderContext = {
      requestId: "req-2",
      baseUrl: "https://worker.example",
      env,
      kv: env.KV,
      log: () => {},
    };

    const result = await DropboxFaxProvider.sendFax(
      { to: "+15558675309", mediaUrl: "https://worker.example/media/file.pdf" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

describe("DropboxFaxProvider.handleWebhook", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("downloads fax media when file_url is present", async () => {
    const kv = new KVStub();
    const env: WorkerEnv = { KV: kv, DROPBOX_SIGN_API_KEY: "dbx_key" };
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
        "Basic " + btoa("dbx_key:"),
      );
      return new Response(fakePdf, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    };

    const webhookEvent = {
      fax: {
        id: "fax_abc",
        file_url: "https://api.hellosign.com/v3/fax/files/fax_abc",
      },
    };

    const req = new Request("https://worker.example/dropbox/fax-rx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(webhookEvent),
    });

    const res = await DropboxFaxProvider.handleWebhook(req, ctx);

    expect(res.status).toBe(200);
    const keys = kv.puts.map((p) => p.key);
    expect(keys).toContain("dropbox:fax:fax_abc.pdf");
    expect(keys).toContain("dropbox:fax:fax_abc:metadata.json");
  });
});

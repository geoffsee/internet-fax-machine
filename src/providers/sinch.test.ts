import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SinchProvider } from "./sinch";
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

describe("SinchProvider.sendFax", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts fax payload to Sinch with basic auth", async () => {
    const captured: { url?: string; headers?: any; body?: any } = {};

    globalThis.fetch = async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      captured.url = url.toString();
      captured.headers = init?.headers;
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ id: "fax_456" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    };

    const env: WorkerEnv = {
      KV: new KVStub(),
      SINCH_PROJECT_ID: "project_1",
      SINCH_ACCESS_KEY: "access",
      SINCH_SECRET_KEY: "secret",
      FAX_FROM: "+15551234567",
    };

    const ctx: ProviderContext = {
      requestId: "req-1",
      baseUrl: "https://worker.example",
      env,
      kv: env.KV,
      log: () => {},
    };

    const result = await SinchProvider.sendFax(
      { to: "+15558675309", mediaUrl: "https://worker.example/media/file.pdf" },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(captured.url).toBe(
      "https://fax.api.sinch.com/v3/projects/project_1/faxes",
    );
    expect(captured.headers?.authorization).toBe(
      "Basic " + btoa("access:secret"),
    );
    expect(captured.body.contentUrl).toBe(
      "https://worker.example/media/file.pdf",
    );
    expect(captured.body.from).toBe("+15551234567");
  });

  it("returns error when env vars are missing", async () => {
    const env: WorkerEnv = {
      KV: new KVStub(),
      SINCH_ACCESS_KEY: "a",
      SINCH_SECRET_KEY: "b",
    };
    const ctx: ProviderContext = {
      requestId: "req-2",
      baseUrl: "https://worker.example",
      env,
      kv: env.KV,
      log: () => {},
    };

    const result = await SinchProvider.sendFax(
      { to: "+15558675309", mediaUrl: "https://worker.example/media/file.pdf" },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

describe("SinchProvider.handleWebhook", () => {
  it("stores multipart fax files and payload", async () => {
    const kv = new KVStub();
    const env: WorkerEnv = { KV: kv };
    const ctx: ProviderContext = {
      requestId: "req-3",
      baseUrl: "https://worker.example",
      env,
      kv,
      log: () => {},
    };

    const form = new FormData();
    form.append("id", "fax_form");
    form.append("direction", "inbound");
    form.append(
      "file",
      new Blob([new Uint8Array([9, 9, 9])], { type: "application/pdf" }),
      "fax.pdf",
    );

    const req = new Request("https://worker.example/sinch/fax-rx", {
      method: "POST",
      body: form,
    });

    const res = await SinchProvider.handleWebhook(req, ctx);

    expect(res.status).toBe(200);
    const keys = kv.puts.map((p) => p.key);
    expect(keys).toContain("sinch:fax:fax_form:fax.pdf");
    expect(keys).toContain("sinch:fax:fax_form:payload.json");
  });
});

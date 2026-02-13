import {
  FaxProvider,
  ProviderContext,
  ProviderSendResult,
  SendFaxParams,
} from "./types";

// Telnyx fax provider implementation
export const TelnyxProvider: FaxProvider = {
  name: "telnyx",
  webhookPath: "/telnyx/fax-rx",

  async sendFax(
    params: SendFaxParams,
    ctx: ProviderContext,
  ): Promise<ProviderSendResult> {
    const { env, baseUrl, log } = ctx;

    if (!env.TELNYX_API_KEY) {
      return {
        ok: false,
        status: 500,
        fax: null,
        raw: { error: "TELNYX_API_KEY not configured" },
      };
    }
    if (!env.CONNECTION_ID) {
      return {
        ok: false,
        status: 500,
        fax: null,
        raw: { error: "CONNECTION_ID not configured" },
      };
    }
    if (!env.FAX_FROM) {
      return {
        ok: false,
        status: 500,
        fax: null,
        raw: { error: "FAX_FROM not configured" },
      };
    }

    log(ctx.requestId, "sending fax (telnyx)", {
      to: params.to,
      from: env.FAX_FROM,
      mediaUrl: params.mediaUrl,
    });

    const telnyxRes = await fetch("https://api.telnyx.com/v2/faxes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TELNYX_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        connection_id: env.CONNECTION_ID,
        from: env.FAX_FROM,
        to: params.to,
        media_url: params.mediaUrl,
        quality: "high",
        t38_enabled: true,
        webhook_url: `${baseUrl}${this.webhookPath}`,
      }),
    });

    const body = await telnyxRes.json();
    log(ctx.requestId, "telnyx fax response", {
      status: telnyxRes.status,
      body,
    });

    return { ok: telnyxRes.ok, status: telnyxRes.status, fax: body, raw: body };
  },

  async handleWebhook(req: Request, ctx: ProviderContext): Promise<Response> {
    const { env, kv, log } = ctx;

    try {
      const event = (await req.json()) as TelnyxWebhookEvent;
      const eventType = event.data?.event_type ?? "unknown";
      const faxId = event.data?.payload?.fax_id ?? ctx.requestId;

      log(ctx.requestId, "telnyx fax webhook", {
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
          log(ctx.requestId, "downloading fax media", {
            mediaUrl: mediaUrl.slice(0, 120),
          });

          const headers: Record<string, string> = {};
          if (env.TELNYX_API_KEY) {
            headers.authorization = `Bearer ${env.TELNYX_API_KEY}`;
          }

          const mediaRes = await fetch(mediaUrl, { method: "GET", headers });
          const mediaBytes = await mediaRes.arrayBuffer();

          const kvKey = `telnyx:fax:${faxId}.pdf`;
          await kv.put(kvKey, mediaBytes);

          log(ctx.requestId, "stored fax media in kv", {
            kvKey,
            bytes: mediaBytes.byteLength,
          });
        } else {
          log(ctx.requestId, "fax.received but no media_url");
          await kv.put(
            `telnyx:fax:${faxId}:meta.json`,
            JSON.stringify(event.data?.payload),
          );
        }
      } else {
        log(ctx.requestId, `event ${eventType} — storing metadata`);
        await kv.put(
          `telnyx:fax:${faxId}:${eventType}.json`,
          JSON.stringify(event.data?.payload),
        );
      }

      return new Response(
        JSON.stringify({ ok: true, requestId: ctx.requestId }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    } catch (err) {
      log(ctx.requestId, "ERROR", {
        message: err instanceof Error ? err.message : String(err),
      });
      return new Response(
        JSON.stringify({
          ok: false,
          requestId: ctx.requestId,
          error: String(err),
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  },
};

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

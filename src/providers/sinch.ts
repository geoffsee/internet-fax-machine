import {
  FaxProvider,
  ProviderContext,
  ProviderSendResult,
  SendFaxParams,
} from "./types";

/**
 * Sinch Fax API provider implementation.
 * Docs: https://developers.sinch.com/docs/fax/overview/ (v3)
 */
export const SinchProvider: FaxProvider = {
  name: "sinch",
  webhookPath: "/sinch/fax-rx",

  async sendFax(
    params: SendFaxParams,
    ctx: ProviderContext,
  ): Promise<ProviderSendResult> {
    const { env, log } = ctx;

    if (!env.SINCH_PROJECT_ID) {
      return {
        ok: false,
        status: 500,
        fax: null,
        raw: { error: "SINCH_PROJECT_ID not configured" },
      };
    }
    if (!env.SINCH_ACCESS_KEY || !env.SINCH_SECRET_KEY) {
      return {
        ok: false,
        status: 500,
        fax: null,
        raw: { error: "SINCH_ACCESS_KEY or SINCH_SECRET_KEY not configured" },
      };
    }

    const payload = {
      to: params.to,
      from: env.FAX_FROM ?? "",
      contentUrl: params.mediaUrl,
    };

    const authHeader =
      "Basic " + btoa(`${env.SINCH_ACCESS_KEY}:${env.SINCH_SECRET_KEY}`);
    const url = `https://fax.api.sinch.com/v3/projects/${env.SINCH_PROJECT_ID}/faxes`;

    log(ctx.requestId, "sending fax (sinch)", {
      url,
      to: payload.to,
      from: payload.from,
      contentUrl: payload.contentUrl,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body; leave as text
    }

    log(ctx.requestId, "sinch fax response", { status: res.status, body });

    return { ok: res.ok, status: res.status, fax: body, raw: body };
  },

  async handleWebhook(req: Request, ctx: ProviderContext): Promise<Response> {
    const { kv, log } = ctx;
    const contentType = req.headers.get("content-type") || "";

    try {
      let faxId = ctx.requestId;
      let fileCount = 0;

      if (contentType.includes("multipart/form-data")) {
        const form = await req.formData();
        const fields: Record<string, string> = {};
        const files: Array<{
          key: string;
          name?: string;
          type: string;
          bytes: ArrayBuffer;
        }> = [];

        for (const [key, value] of form.entries()) {
          if (typeof value === "string") {
            fields[key] = value;
          } else {
            files.push({
              key,
              name: value.name,
              type: value.type,
              bytes: await value.arrayBuffer(),
            });
          }
        }

        faxId = fields["id"] ?? fields["faxId"] ?? faxId;
        for (const file of files) {
          const kvKey = `sinch:fax:${faxId}:${file.name || file.key}`;
          await kv.put(kvKey, file.bytes, {
            metadata: { filename: file.name, contentType: file.type },
          });
          fileCount++;
        }
        await kv.put(`sinch:fax:${faxId}:payload.json`, JSON.stringify(fields));
        log(ctx.requestId, "stored sinch webhook form data", {
          faxId,
          fileCount,
          fields: Object.keys(fields),
        });
      } else if (contentType.includes("application/json")) {
        const body = await req.json();
        faxId = body?.id ?? body?.fax_id ?? body?.data?.id ?? faxId;
        await kv.put(`sinch:fax:${faxId}:payload.json`, JSON.stringify(body));
        log(ctx.requestId, "stored sinch webhook json", {
          faxId,
          keys: Object.keys(body || {}),
        });
      } else {
        const text = await req.text();
        await kv.put(`sinch:fax:${faxId}:raw.txt`, text);
        log(ctx.requestId, "stored sinch webhook raw text", {
          faxId,
          length: text.length,
        });
      }

      return new Response(
        JSON.stringify(
          { ok: true, requestId: ctx.requestId, faxId, filesStored: fileCount },
          null,
          2,
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (err) {
      log(ctx.requestId, "ERROR", {
        message: err instanceof Error ? err.message : String(err),
      });
      return new Response(
        JSON.stringify(
          { ok: false, requestId: ctx.requestId, error: String(err) },
          null,
          2,
        ),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  },
};

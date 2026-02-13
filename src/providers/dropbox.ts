import {
  FaxProvider,
  ProviderContext,
  ProviderSendResult,
  SendFaxParams,
} from "./types";

/**
 * Dropbox Fax (HelloFax / Dropbox Sign) provider implementation.
 * Uses the Dropbox Sign Fax API endpoint: POST https://api.hellosign.com/v3/fax/send
 */
export const DropboxFaxProvider: FaxProvider = {
  name: "dropbox-fax",
  webhookPath: "/dropbox/fax-rx",

  async sendFax(
    params: SendFaxParams,
    ctx: ProviderContext,
  ): Promise<ProviderSendResult> {
    const { env, log } = ctx;

    if (!env.DROPBOX_SIGN_API_KEY) {
      return {
        ok: false,
        status: 500,
        fax: null,
        raw: { error: "DROPBOX_SIGN_API_KEY not configured" },
      };
    }

    const testMode = env.DROPBOX_FAX_TEST_MODE === "0" ? false : true;
    const payload = {
      recipient: params.to,
      sender: env.FAX_FROM || undefined,
      file_urls: [params.mediaUrl],
      test_mode: testMode,
      title: "Fax via Internet Fax Worker",
    };

    const authHeader = "Basic " + btoa(`${env.DROPBOX_SIGN_API_KEY}:`);

    log(ctx.requestId, "sending fax (dropbox-fax)", {
      to: params.to,
      from: payload.sender,
      mediaUrl: params.mediaUrl,
      testMode,
    });

    const res = await fetch("https://api.hellosign.com/v3/fax/send", {
      method: "POST",
      headers: {
        authorization: authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON response; leave as text
    }

    log(ctx.requestId, "dropbox-fax response", {
      status: res.status,
      body: body,
    });

    return { ok: res.ok, status: res.status, fax: body, raw: body };
  },

  async handleWebhook(req: Request, ctx: ProviderContext): Promise<Response> {
    const { env, kv, log } = ctx;
    const contentType = req.headers.get("content-type") || "";

    try {
      let faxId = ctx.requestId;
      let payload: any = null;
      let filesStored = 0;

      if (contentType.includes("application/json")) {
        payload = await req.json();
        faxId =
          payload?.fax?.id ?? payload?.event?.fax_id ?? payload?.id ?? faxId;
      } else if (contentType.includes("multipart/form-data")) {
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

        payload = fields;
        faxId = fields["fax_id"] ?? fields["id"] ?? faxId;

        for (const file of files) {
          const kvKey = `dropbox:fax:${faxId}:${file.name || file.key}`;
          await kv.put(kvKey, file.bytes, {
            metadata: { filename: file.name, contentType: file.type },
          });
          filesStored++;
        }
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const text = await req.text();
        payload = Object.fromEntries(new URLSearchParams(text));
        faxId = payload["fax_id"] ?? faxId;
      } else {
        const text = await req.text();
        payload = { raw: text };
      }

      // If the payload references a downloadable fax file, fetch and store it.
      const fileUrl = payload?.file_url || payload?.fax?.file_url;
      if (fileUrl) {
        const headers: Record<string, string> = {};
        if (env.DROPBOX_SIGN_API_KEY) {
          headers.authorization =
            "Basic " + btoa(`${env.DROPBOX_SIGN_API_KEY}:`);
        }
        const res = await fetch(fileUrl, { headers });
        if (res.ok) {
          const bytes = await res.arrayBuffer();
          const kvKey = `dropbox:fax:${faxId}.pdf`;
          await kv.put(kvKey, bytes, {
            metadata: {
              contentType: res.headers.get("content-type") || "application/pdf",
            },
          });
          filesStored++;
          log(ctx.requestId, "stored dropbox fax media", {
            kvKey,
            bytes: bytes.byteLength,
          });
        } else {
          log(ctx.requestId, "failed to fetch fax media", {
            status: res.status,
            fileUrl,
          });
        }
      }

      await kv.put(
        `dropbox:fax:${faxId}:metadata.json`,
        JSON.stringify(payload),
      );

      return new Response(
        JSON.stringify(
          { ok: true, requestId: ctx.requestId, faxId, filesStored },
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

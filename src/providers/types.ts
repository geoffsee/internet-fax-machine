export type WorkerEnv = {
  KV: KVNamespace;
  /** Which fax provider implementation to use (e.g., "telnyx"). Defaults to telnyx */
  FAX_PROVIDER?: string;
  /** Basic auth user for protected endpoints */
  BASIC_AUTH_USER?: string;
  /** Basic auth password for protected endpoints */
  BASIC_AUTH_PASS?: string;

  // Telnyx-specific settings (used by the Telnyx provider)
  TELNYX_API_KEY?: string;
  CONNECTION_ID?: string;
  FAX_FROM?: string;

  // Dropbox Fax (HelloFax/Dropbox Sign) settings
  DROPBOX_SIGN_API_KEY?: string;
  /** Set to "0" to disable test mode when sending via Dropbox Fax */
  DROPBOX_FAX_TEST_MODE?: string;

  // Sinch Fax API settings
  SINCH_PROJECT_ID?: string;
  SINCH_ACCESS_KEY?: string;
  SINCH_SECRET_KEY?: string;
};

export type ProviderContext = {
  requestId: string;
  baseUrl: string;
  env: WorkerEnv;
  kv: KVNamespace;
  log: (requestId: string, message: string, meta?: unknown) => void;
};

export type SendFaxParams = {
  to: string;
  mediaUrl: string;
};

export type ProviderSendResult = {
  ok: boolean;
  status: number;
  fax: unknown;
  raw?: unknown;
};

export interface FaxProvider {
  /** Provider name ("telnyx", etc.) */
  name: string;
  /** Path the provider expects for webhook callbacks (leading slash) */
  webhookPath: string;

  /**
   * Send a fax using this provider.
   * The worker has already stored the media and provides a public media URL.
   */
  sendFax(
    params: SendFaxParams,
    ctx: ProviderContext,
  ): Promise<ProviderSendResult>;

  /**
   * Handle inbound webhooks from the provider.
   * Implementations should return a Response suitable for the worker fetch handler.
   */
  handleWebhook(req: Request, ctx: ProviderContext): Promise<Response>;
}

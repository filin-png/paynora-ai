/** Web search is turned off (WEB_SEARCH_PROVIDER=none, the default) or has no configured provider. */
export class WebSearchDisabledError extends Error {
  constructor() {
    super("Web search is disabled (WEB_SEARCH_PROVIDER=none)");
    this.name = "WebSearchDisabledError";
  }
}

/** A search vendor is recognized (selectable via WEB_SEARCH_PROVIDER) but has no real adapter yet — same precedent as AI_PROVIDER's gigachat/yandex. */
export class WebSearchProviderNotImplementedError extends Error {
  constructor(provider: string) {
    super(`Web search provider "${provider}" is not implemented yet — see docs/production-integrations.md#web-intelligence`);
    this.name = "WebSearchProviderNotImplementedError";
  }
}

export class WebSearchTimeoutError extends Error {
  constructor() {
    super("Web search timed out");
    this.name = "WebSearchTimeoutError";
  }
}

/** A search vendor call failed or returned an error — never contains the raw request/response body (may include a secret-free vendor error code). */
export class WebSearchProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchProviderError";
  }
}

import { WebSearchDisabledError } from "../errors";
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from "../types";

export const noneWebSearchProvider: WebSearchProvider = {
  name: "none",
  search(_request: WebSearchRequest): Promise<WebSearchResult> {
    throw new WebSearchDisabledError();
  },
};

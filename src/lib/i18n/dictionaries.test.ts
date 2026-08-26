import { describe, expect, it } from "vitest";

import { en } from "./dictionaries/en";
import { ru } from "./dictionaries/ru";
import { DEFAULT_LOCALE, isSupportedLocale, SUPPORTED_LOCALES } from "./config";
import { getDictionary } from "./index";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n dictionaries", () => {
  it("ru has exactly the same key shape as en — no missing or extra translation", () => {
    expect(leafKeys(ru).sort()).toEqual(leafKeys(en).sort());
  });

  it("every leaf value in every dictionary is a non-empty string", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const dict = getDictionary(locale);
      for (const key of leafKeys(dict)) {
        const value = key.split(".").reduce<unknown>((obj, part) => (obj as Record<string, unknown>)[part], dict);
        expect(typeof value).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("getDictionary returns a distinct dictionary per locale", () => {
    expect(getDictionary("en").nav.overview).not.toBe(getDictionary("ru").nav.overview);
  });
});

describe("isSupportedLocale", () => {
  it("accepts exactly the supported locales", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("ru")).toBe(true);
  });

  it("rejects anything else, including undefined/null/empty", () => {
    expect(isSupportedLocale("fr")).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale("")).toBe(false);
  });
});

describe("DEFAULT_LOCALE", () => {
  it("is itself a supported locale", () => {
    expect(isSupportedLocale(DEFAULT_LOCALE)).toBe(true);
  });
});

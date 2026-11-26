import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { adapter, client, env } = vi.hoisted(() => ({
  adapter: vi.fn(class TestAdapter {}),
  client: vi.fn(class TestClient {}),
  env: { NODE_ENV: "development", DATABASE_URL: "postgresql://fixture@dev.example.invalid/paynora", DATABASE_POOL_MAX: 3 },
}));

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: adapter }));
vi.mock("@prisma/client", () => ({ PrismaClient: client }));
vi.mock("@/lib/env", () => ({ env }));

const validUrl = "postgresql://paynora_test_runner:fixture@127.0.0.1:55432/paynora_test?schema=public";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  env.NODE_ENV = "development";
  vi.stubEnv("VITEST", "true");
  vi.stubEnv("TEST_DATABASE_URL", undefined);
  vi.stubGlobal("prisma", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([undefined, validUrl.replace("55432", "5432")])(
  "fails before creating the adapter if the test URL is missing or invalid (%s)",
  async (target) => {
    vi.stubEnv("TEST_DATABASE_URL", target);
    vi.stubGlobal("prisma", { existingClient: true });

    await expect(import("./client")).rejects.toThrow("TEST_DATABASE_URL must point");
    expect(adapter).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  },
);

it("uses the isolated URL over DATABASE_URL and ignores a previously cached client in Vitest", async () => {
  vi.stubEnv("TEST_DATABASE_URL", validUrl);
  const cached = { existingClient: true };
  vi.stubGlobal("prisma", cached);

  const { prisma } = await import("./client");

  expect(adapter).toHaveBeenCalledExactlyOnceWith({ connectionString: validUrl, max: 3 });
  expect(client).toHaveBeenCalledTimes(1);
  expect(prisma).not.toBe(cached);
});

it("also validates the target in NODE_ENV=test outside Vitest", async () => {
  vi.stubEnv("VITEST", undefined);
  env.NODE_ENV = "test";

  await expect(import("./client")).rejects.toThrow("TEST_DATABASE_URL must point");
  expect(adapter).not.toHaveBeenCalled();
});

it.each(["development", "production"])("preserves DATABASE_URL use outside tests in %s", async (mode) => {
  vi.stubEnv("VITEST", undefined);
  env.NODE_ENV = mode;

  await import("./client");

  expect(adapter).toHaveBeenCalledExactlyOnceWith({ connectionString: env.DATABASE_URL, max: 3 });
});

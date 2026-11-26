import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetDatabase } from "./test-utils";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("./client", () => ({ prisma: { $transaction: transaction } }));

const deleteOrder = [
  "rateLimitCounter", "automationTickRun", "passwordResetToken", "organizationInvitation",
  "billingCheckoutSession", "subscriptionPayment", "organizationSubscription", "supportRequest",
  "deliveryAttempt", "communication", "collectionStepExecution", "actionProposal", "operatorInsight",
  "businessEvent", "collectionSequence", "collectionPolicyStep", "collectionPolicy", "walletTransaction",
  "cryptoPaymentRequest", "wallet", "activityEvent", "payment", "invoice", "customer",
  "organizationMember", "organization", "user",
] as const;

function mockTransaction() {
  const trace: string[] = [];
  const query = vi.fn(async (..._args: unknown[]) => {
    trace.push("verify");
    return [{ ok: true }] as { ok: boolean | null }[];
  });
  const delegates = Object.fromEntries(deleteOrder.map((model) => [model, {
    deleteMany: vi.fn(async () => {
      trace.push(`start:${model}`);
      await Promise.resolve();
      trace.push(`end:${model}`);
    }),
  }]));
  const tx = { ...delegates, $queryRaw: query };
  transaction.mockImplementation(async (run: (client: typeof tx) => Promise<void>) => run(tx));

  return { query, trace, delegates };
}

describe("resetDatabase", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "development", "production"])("refuses NODE_ENV=%s without opening a transaction", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);

    await expect(resetDatabase()).rejects.toThrow("requires NODE_ENV=test");
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a mismatched database, role, endpoint, or cluster", rows: [{ ok: false }] },
    { label: "an unknown identity", rows: [{ ok: null }] },
    { label: "no identity row", rows: [] },
  ])("deletes nothing for $label", async ({ rows }) => {
    const { query, trace } = mockTransaction();
    query.mockResolvedValue(rows);

    await expect(resetDatabase()).rejects.toThrow("outside the isolated PAYNORA test cluster");
    expect(query).toHaveBeenCalledTimes(1);
    expect(trace.filter((step) => step.startsWith("start:"))).toEqual([]);
  });

  it("deletes nothing if the identity query fails", async () => {
    const { query, trace } = mockTransaction();
    query.mockRejectedValue(new Error("identity query failed"));

    await expect(resetDatabase()).rejects.toThrow("identity query failed");
    expect(trace).toEqual([]);
  });

  it("verifies the server and then awaits all 27 deletions in order on the same transaction", async () => {
    const { query, trace } = mockTransaction();

    await resetDatabase();

    expect(transaction).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0] as [TemplateStringsArray];
    expect(sql.join("")).toMatch(/current_database\(\) = 'paynora_test'/);
    expect(sql.join("")).toContain("session_user = 'paynora_test_runner'");
    expect(sql.join("")).toContain("current_user = 'paynora_test_runner'");
    expect(sql.join("")).toContain("inet_server_addr() = '127.0.0.1'::inet");
    expect(sql.join("")).toContain("inet_server_port() = 55432");
    expect(sql.join("")).toContain("current_schema() = 'public'");
    expect(sql.join("")).toContain("current_setting('cluster_name', true) = 'paynora_test_isolated'");
    expect(trace).toEqual(["verify", ...deleteOrder.flatMap((model) => [`start:${model}`, `end:${model}`])]);
  });

  it("propagates a deletion failure and leaves remaining deletions uncalled", async () => {
    const { delegates, trace } = mockTransaction();
    delegates.passwordResetToken!.deleteMany.mockRejectedValueOnce(new Error("delete failed"));

    await expect(resetDatabase()).rejects.toThrow("delete failed");
    expect(trace).toEqual([
      "verify",
      "start:rateLimitCounter", "end:rateLimitCounter",
      "start:automationTickRun", "end:automationTickRun",
    ]);
    expect(delegates.user!.deleteMany).not.toHaveBeenCalled();
  });
});

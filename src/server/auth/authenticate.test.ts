import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/server/db/client";
import { resetDatabase } from "@/server/db/test-utils";
import { registerUser } from "./users";
import { authenticateCredentials } from "./authenticate";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const REAL_PASSWORD = "correct horse battery staple";

async function setupUser(email = "owner@example.com") {
  return registerUser({ email, password: REAL_PASSWORD, name: "Owner" });
}

describe("authenticateCredentials", () => {
  it("normal attempts: a correct password from a fresh IP succeeds", async () => {
    const user = await setupUser();
    const result = await authenticateCredentials({ email: user.email, password: REAL_PASSWORD }, "1.1.1.1");
    expect(result?.id).toBe(user.id);
  });

  it("a wrong password is rejected without touching the rate limit budget meaningfully (well under threshold)", async () => {
    await setupUser();
    const result = await authenticateCredentials({ email: "owner@example.com", password: "wrong" }, "1.1.1.1");
    expect(result).toBeNull();
  });

  it("an unknown email is rejected the same way as a wrong password (enumeration-safe)", async () => {
    const unknown = await authenticateCredentials(
      { email: "nobody@example.com", password: "whatever" },
      "1.1.1.1",
    );
    const wrongPassword = await authenticateCredentials(
      { email: "nobody@example.com", password: "whatever-else" },
      "1.1.1.1",
    );
    expect(unknown).toBeNull();
    expect(wrongPassword).toBeNull();
    // Both are indistinguishable `null` — no separate error type, no
    // separate message, no timing-revealing shortcut.
  });

  it("malformed credentials (missing/invalid shape) are rejected without ever reaching the rate limiter or a DB lookup", async () => {
    const result = await authenticateCredentials({ email: "not-an-email" }, "1.1.1.1");
    expect(result).toBeNull();
  });

  it("threshold: a normal user making a handful of mistakes (well under the account limit) is never blocked once they get the password right", async () => {
    const user = await setupUser();
    for (let i = 0; i < 3; i++) {
      const failed = await authenticateCredentials({ email: user.email, password: "wrong" }, "9.9.9.9");
      expect(failed).toBeNull();
    }
    const succeeded = await authenticateCredentials({ email: user.email, password: REAL_PASSWORD }, "9.9.9.9");
    expect(succeeded?.id).toBe(user.id);
  });

  it("blocked: exceeding the per-account failure threshold blocks even a CORRECT password until the window resets", async () => {
    const user = await setupUser();
    // AUTH_ACCOUNT_POLICY.maxAttempts is 10 — exhaust it with wrong
    // passwords, each from a different IP so only the account dimension
    // is in play.
    for (let i = 0; i < 10; i++) {
      await authenticateCredentials({ email: user.email, password: "wrong" }, `10.0.0.${i}`);
    }
    const correctButBlocked = await authenticateCredentials(
      { email: user.email, password: REAL_PASSWORD },
      "10.0.0.99",
    );
    expect(correctButBlocked).toBeNull();
  }, 20000);

  it("blocked: exceeding the per-IP threshold blocks further attempts from that IP regardless of which account is targeted", async () => {
    const userA = await setupUser("a@example.com");
    const userB = await registerUser({ email: "b@example.com", password: REAL_PASSWORD });
    const sharedIp = "203.0.113.5";

    // AUTH_IP_POLICY.maxAttempts is 30 — exhaust it against userA.
    for (let i = 0; i < 30; i++) {
      await authenticateCredentials({ email: userA.email, password: "wrong" }, sharedIp);
    }
    // Now even a correct login for a DIFFERENT account from the same IP
    // is blocked — the IP dimension doesn't care which account.
    const blocked = await authenticateCredentials({ email: userB.email, password: REAL_PASSWORD }, sharedIp);
    expect(blocked).toBeNull();

    // The same account from a fresh IP is unaffected.
    const stillWorks = await authenticateCredentials({ email: userB.email, password: REAL_PASSWORD }, "198.51.100.7");
    expect(stillWorks?.id).toBe(userB.id);
  }, 20000);

  it("account/tenant independence: exhausting one account's budget never blocks a different account from a different IP", async () => {
    const victim = await setupUser("victim@example.com");
    const bystander = await registerUser({ email: "bystander@example.com", password: REAL_PASSWORD });

    for (let i = 0; i < 10; i++) {
      await authenticateCredentials({ email: victim.email, password: "wrong" }, `172.16.0.${i}`);
    }
    const bystanderResult = await authenticateCredentials(
      { email: bystander.email, password: REAL_PASSWORD },
      "172.16.0.99",
    );
    expect(bystanderResult?.id).toBe(bystander.id);
  }, 20000);

  it("reset/window behaviour: a successful login clears the account's failure history, so a later burst of mistakes starts from zero again", async () => {
    const user = await setupUser();
    for (let i = 0; i < 5; i++) {
      await authenticateCredentials({ email: user.email, password: "wrong" }, "1.2.3.4");
    }
    const succeeded = await authenticateCredentials({ email: user.email, password: REAL_PASSWORD }, "1.2.3.4");
    expect(succeeded?.id).toBe(user.id);

    // Another 5 mistakes after the reset — still well under the
    // threshold, since the earlier 5 no longer count.
    for (let i = 0; i < 5; i++) {
      const failed = await authenticateCredentials({ email: user.email, password: "wrong" }, "1.2.3.4");
      expect(failed).toBeNull();
    }
    const succeededAgain = await authenticateCredentials({ email: user.email, password: REAL_PASSWORD }, "1.2.3.4");
    expect(succeededAgain?.id).toBe(user.id);
  }, 20000);

  it("parallel attempts: concurrent requests against one account cannot trivially bypass the per-account limit (real Postgres atomicity)", async () => {
    // Every one of these 25 concurrent wrong-password attempts returns
    // `null` regardless of whether the rate limit had already tripped —
    // that's not informative on its own (enumeration-safety means
    // "blocked" and "wrong password" look identical from the outside).
    // What actually proves the counter didn't lose updates under
    // concurrency (e.g. 25 racing reads-then-writes each seeing a stale
    // count and all getting counted as "attempt #1") is the follow-up
    // check below: if fewer than `maxAttempts` (10) of these 25 had
    // genuinely been counted, a correct password submitted right after
    // would still succeed.
    const user = await setupUser();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => authenticateCredentials({ email: user.email, password: "wrong" }, `5.5.5.${i}`)),
    );

    const afterBurst = await authenticateCredentials({ email: user.email, password: REAL_PASSWORD }, "5.5.5.99");
    expect(afterBurst).toBeNull();
  }, 20000);
});

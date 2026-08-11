import { registerUser } from "@/server/auth/users";
import { createOrganization } from "@/server/tenancy/organizations";

export async function createTestOrganization(namePrefix = "Org") {
  const suffix = Math.random().toString(36).slice(2, 8);
  const emailSlug = namePrefix.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const user = await registerUser({
    email: `${emailSlug}-${suffix}@example.com`,
    password: "password123",
  });
  const organization = await createOrganization(user, `${namePrefix} ${suffix}`);
  return { user, organization };
}

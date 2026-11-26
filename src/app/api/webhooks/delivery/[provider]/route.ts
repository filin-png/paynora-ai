import {
  DeliveryEventConflictError,
  DeliveryEvidenceUncorrelatedError,
  deliveryWebhookAdapters,
} from "@/server/communications/delivery-evidence";
import { recordVerifiedDeliveryWebhook } from "@/server/communications/delivery-provider-events";
import { ZodError } from "zod";

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const adapter = deliveryWebhookAdapters.get(provider);
  if (!adapter) return new Response(null, { status: 404 });

  try {
    const verified = await adapter.verify(request);
    if (!verified) return new Response(null, { status: 401 });
    await recordVerifiedDeliveryWebhook(provider, verified);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof DeliveryEventConflictError) return new Response(null, { status: 409 });
    if (error instanceof DeliveryEvidenceUncorrelatedError) return new Response(null, { status: 422 });
    if (error instanceof ZodError) return new Response(null, { status: 400 });
    throw error;
  }
}

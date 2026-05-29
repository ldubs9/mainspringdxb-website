// Mainspring Dubai — Ziina Payment Webhook Handler
// Ziina POSTs payment events here, or this can be polled on return.
// Deploy: supabase functions deploy ziina-webhook
//
// This function:
// 1. Receives the Ziina webhook payload
// 2. Verifies the payment intent status by re-fetching from Ziina API
// 3. Updates the order payment status in the database

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    const paymentIntentId = payload.id || payload.payment_intent_id;

    if (!paymentIntentId) {
      return new Response("Missing payment_intent_id", { status: 400 });
    }

    const ZIINA_API_KEY = Deno.env.get("MAINSPRING_ZIINA_API_KEY");
    if (!ZIINA_API_KEY) {
      console.error("ZIINA_API_KEY not set");
      return new Response("Server config error", { status: 500 });
    }

    // --- Verify by re-fetching the Payment Intent from Ziina API ---
    // Never trust the webhook payload status alone
    const verifyResponse = await fetch(
      `https://api-v2.ziina.com/api/payment_intent/${paymentIntentId}`,
      {
        headers: {
          "Authorization": `Bearer ${ZIINA_API_KEY}`,
        },
      }
    );

    const intent = await verifyResponse.json();

    if (!verifyResponse.ok) {
      console.error("Failed to verify Ziina payment intent:", intent);
      return new Response("Verification failed", { status: 502 });
    }

    // Map Ziina status to our internal payment status
    let paymentStatus: string;
    switch (intent.status) {
      case "completed":
        paymentStatus = "paid";
        break;
      case "failed":
        paymentStatus = "failed";
        break;
      case "canceled":
        paymentStatus = "cancelled";
        break;
      case "pending":
      case "requires_user_action":
        paymentStatus = "processing";
        break;
      default:
        paymentStatus = "pending";
    }

    // --- Update order in DB ---
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: order, error: fetchError } = await supabaseAdmin
      .from("mainspring_orders")
      .select("order_ref")
      .eq("payment_gateway_ref", paymentIntentId)
      .single();

    if (fetchError || !order) {
      console.error("Order not found for payment_intent:", paymentIntentId, fetchError);
      return new Response("Order not found", { status: 404 });
    }

    const { error: updateError } = await supabaseAdmin
      .from("mainspring_orders")
      .update({ payment_status: paymentStatus })
      .eq("payment_gateway_ref", paymentIntentId);

    if (updateError) {
      console.error("Failed to update order status:", updateError);
      return new Response("DB update failed", { status: 500 });
    }

    console.log(
      `Ziina webhook: order ${order.order_ref} → ${paymentStatus} (intent ${paymentIntentId})`
    );

    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("ziina-webhook error:", err);
    return new Response("Internal server error", { status: 500 });
  }
});

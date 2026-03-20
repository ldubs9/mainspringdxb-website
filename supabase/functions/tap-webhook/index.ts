// Mainspring Dubai — Tap Payments Webhook Handler
// Tap POSTs payment results here after customer completes payment.
// Deploy: supabase functions deploy tap-webhook
//
// This function:
// 1. Verifies the webhook is genuine (checks with Tap API)
// 2. Updates the order payment status in the database
// 3. Logs the status change

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  // Tap webhooks are always POST
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    const chargeId = payload.id;

    if (!chargeId) {
      return new Response("Missing charge ID", { status: 400 });
    }

    // --- VERIFY with Tap API (never trust the webhook payload alone) ---
    const TAP_SECRET_KEY = Deno.env.get("TAP_SECRET_KEY");
    if (!TAP_SECRET_KEY) {
      console.error("TAP_SECRET_KEY not set");
      return new Response("Server config error", { status: 500 });
    }

    const verifyResponse = await fetch(`https://api.tap.company/v2/charges/${chargeId}`, {
      headers: {
        "Authorization": `Bearer ${TAP_SECRET_KEY}`,
      },
    });

    const charge = await verifyResponse.json();

    if (!verifyResponse.ok) {
      console.error("Failed to verify charge:", charge);
      return new Response("Verification failed", { status: 502 });
    }

    // Map Tap status to our payment status
    let paymentStatus: string;
    switch (charge.status) {
      case "CAPTURED":
        paymentStatus = "paid";
        break;
      case "FAILED":
      case "DECLINED":
      case "RESTRICTED":
      case "VOID":
        paymentStatus = "failed";
        break;
      case "INITIATED":
      case "AUTHORIZED":
        paymentStatus = "processing";
        break;
      case "CANCELLED":
        paymentStatus = "cancelled";
        break;
      default:
        paymentStatus = "pending";
    }

    // --- Update order in DB (service role — full access) ---
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const orderRef = charge.reference?.order || charge.reference?.transaction;

    if (!orderRef) {
      console.error("No order reference in charge");
      return new Response("No order reference", { status: 400 });
    }

    const { error: updateError } = await supabaseAdmin
      .from("orders")
      .update({
        payment_status: paymentStatus,
        payment_gateway_id: chargeId,
        payment_gateway_response: charge, // Store full response for records
        order_status: paymentStatus === "paid" ? "confirmed" : undefined,
      })
      .eq("order_ref", orderRef);

    if (updateError) {
      console.error("Failed to update order:", updateError);
      return new Response("DB update failed", { status: 500 });
    }

    console.log(`Order ${orderRef}: payment ${paymentStatus} (charge ${chargeId})`);

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("Internal error", { status: 500 });
  }
});

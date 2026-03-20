// Mainspring Dubai — Tap Payments Checkout Edge Function
// Creates a Tap charge/session server-side. Card details never touch your server.
// Deploy: supabase functions deploy tap-checkout
//
// SETUP:
// 1. Sign up at tap.company, get your Secret Key
// 2. Set the secret in Supabase: supabase secrets set TAP_SECRET_KEY=sk_live_xxxxx
// 3. Set your site URL: supabase secrets set SITE_URL=https://mainspringdxb.com

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { order_ref, customer_name, customer_email, customer_phone } = await req.json();

    if (!order_ref) {
      return new Response(
        JSON.stringify({ error: "Missing order_ref" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch order from DB using service role
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: order, error: fetchError } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("order_ref", order_ref)
      .single();

    if (fetchError || !order) {
      return new Response(
        JSON.stringify({ error: "Order not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (order.payment_status === "paid") {
      return new Response(
        JSON.stringify({ error: "Order already paid" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Create Tap Charge ---
    // Tap Secret Key is stored in Supabase secrets, NEVER in client code
    const TAP_SECRET_KEY = Deno.env.get("TAP_SECRET_KEY");
    const SITE_URL = Deno.env.get("SITE_URL") || "https://mainspringdxb.com";

    if (!TAP_SECRET_KEY) {
      console.error("TAP_SECRET_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Payment gateway not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tapResponse = await fetch("https://api.tap.company/v2/charges", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TAP_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: order.total_aed,
        currency: "AED",
        customer_initiated: true,
        threeDSecure: true,
        save_card: false,
        description: `Mainspring Dubai Order ${order.order_ref}`,
        reference: {
          transaction: order.order_ref,
          order: order.order_ref,
        },
        receipt: {
          email: true,
          sms: true,
        },
        customer: {
          first_name: customer_name || order.customer_name,
          email: customer_email || order.customer_email || "",
          phone: {
            country_code: "971",
            number: (customer_phone || order.customer_phone || "").replace(/^\+?971/, ""),
          },
        },
        source: { id: "src_all" }, // Accept all card types
        post: {
          // Webhook URL — Tap will POST payment result here
          url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/tap-webhook`,
        },
        redirect: {
          // Customer is redirected here after payment
          url: `${SITE_URL}?order=${order.order_ref}&status=tap_complete`,
        },
      }),
    });

    const tapData = await tapResponse.json();

    if (!tapResponse.ok || !tapData.transaction?.url) {
      console.error("Tap API error:", tapData);
      return new Response(
        JSON.stringify({ error: "Failed to create payment session" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update order with Tap charge ID
    await supabaseAdmin
      .from("orders")
      .update({
        payment_gateway_id: tapData.id,
        payment_status: "processing",
      })
      .eq("order_ref", order_ref);

    // Return the Tap payment URL — customer is redirected to Tap's hosted page
    return new Response(
      JSON.stringify({
        success: true,
        payment_url: tapData.transaction.url,
        charge_id: tapData.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Tap checkout error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

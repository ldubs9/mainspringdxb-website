// Mainspring Dubai — Ziina Card Payment Checkout Edge Function
// Creates a Ziina Payment Intent server-side. API key never touches the browser.
// Deploy: supabase functions deploy ziina-checkout
//
// SETUP:
// 1. Set your Ziina API key: supabase secrets set MAINSPRING_ZIINA_API_KEY=<your_key>
// 2. Set your site URL: supabase secrets set SITE_URL=https://mainspringdxb.com

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
    const { order_ref } = await req.json();

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
      .from("mainspring_orders")
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

    const ZIINA_API_KEY = Deno.env.get("MAINSPRING_ZIINA_API_KEY");
    const SITE_URL = Deno.env.get("SITE_URL") || "https://mainspringdxb.com";

    if (!ZIINA_API_KEY) {
      console.error("ZIINA_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Payment gateway not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Ziina requires amounts in fils (smallest currency unit): 1 AED = 100 fils
    const amountInFils = Math.round(order.total_aed * 100);

    // Minimum is 200 fils (2 AED)
    if (amountInFils < 200) {
      return new Response(
        JSON.stringify({ error: "Order total is below the minimum payment amount (2 AED)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Create Ziina Payment Intent ---
    const ziinaResponse = await fetch("https://api-v2.ziina.com/api/payment_intent", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ZIINA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountInFils,
        currency_code: "AED",
        message: `Mainspring Dubai — Order ${order_ref}`,
        success_url: `${SITE_URL}?order=${order_ref}&status=ziina_success`,
        cancel_url: `${SITE_URL}?order=${order_ref}&status=ziina_cancel`,
        failure_url: `${SITE_URL}?order=${order_ref}&status=ziina_failed`,
      }),
    });

    const ziinaData = await ziinaResponse.json();

    if (!ziinaResponse.ok || !ziinaData.redirect_url) {
      console.error("Ziina API error:", ziinaData);
      return new Response(
        JSON.stringify({ error: "Failed to create payment session" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Store the Ziina payment intent ID on the order for webhook reconciliation
    await supabaseAdmin
      .from("mainspring_orders")
      .update({
        payment_gateway_ref: ziinaData.id,
        payment_status: "processing",
      })
      .eq("order_ref", order_ref);

    return new Response(
      JSON.stringify({
        success: true,
        payment_url: ziinaData.redirect_url,
        payment_intent_id: ziinaData.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("ziina-checkout error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

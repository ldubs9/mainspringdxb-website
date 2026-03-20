// Mainspring Dubai — Tamara Checkout Edge Function
// Creates a Tamara checkout session server-side.
// Deploy: supabase functions deploy tamara-checkout
//
// SETUP:
// 1. Apply at tamara.co/business
// 2. Get your API Token
// 3. Set secrets:
//    supabase secrets set TAMARA_API_TOKEN=your_token
//    supabase secrets set SITE_URL=https://mainspringdxb.com
// 4. For sandbox/testing, use: https://api-sandbox.tamara.co
//    For production, use: https://api.tamara.co

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

    const TAMARA_API_TOKEN = Deno.env.get("TAMARA_API_TOKEN");
    const SITE_URL = Deno.env.get("SITE_URL") || "https://mainspringdxb.com";
    // Switch to https://api.tamara.co for production
    const TAMARA_API_URL = Deno.env.get("TAMARA_API_URL") || "https://api-sandbox.tamara.co";

    if (!TAMARA_API_TOKEN) {
      return new Response(
        JSON.stringify({ error: "Tamara not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Create Tamara Checkout Session ---
    const tamaraResponse = await fetch(`${TAMARA_API_URL}/checkout`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TAMARA_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        order_reference_id: order.order_ref,
        total_amount: {
          amount: order.total_aed,
          currency: "AED",
        },
        description: `Mainspring Dubai Order ${order.order_ref}`,
        country_code: "AE",
        payment_type: "PAY_BY_INSTALMENTS",
        instalments: 3,
        locale: "en_US",
        items: order.items.map((item: any) => ({
          reference_id: String(item.id),
          type: "physical",
          name: `${item.brand} ${item.name}`,
          sku: String(item.id),
          quantity: item.qty,
          unit_price: {
            amount: item.price,
            currency: "AED",
          },
          total_amount: {
            amount: item.price * item.qty,
            currency: "AED",
          },
        })),
        consumer: {
          first_name: order.customer_name.split(" ")[0] || order.customer_name,
          last_name: order.customer_name.split(" ").slice(1).join(" ") || ".",
          phone_number: order.customer_phone,
          email: order.customer_email || "customer@mainspringdxb.com",
        },
        shipping_address: {
          first_name: order.customer_name.split(" ")[0] || order.customer_name,
          last_name: order.customer_name.split(" ").slice(1).join(" ") || ".",
          line1: order.customer_address || "Dubai, UAE",
          city: "Dubai",
          country_code: "AE",
          phone_number: order.customer_phone,
        },
        tax_amount: { amount: 0, currency: "AED" },
        shipping_amount: { amount: 0, currency: "AED" },
        merchant_url: {
          success: `${SITE_URL}?order=${order.order_ref}&status=tamara_success`,
          failure: `${SITE_URL}?order=${order.order_ref}&status=tamara_failure`,
          cancel: `${SITE_URL}?order=${order.order_ref}&status=tamara_cancel`,
          notification: `${Deno.env.get("SUPABASE_URL")}/functions/v1/tamara-webhook`,
        },
      }),
    });

    const tamaraData = await tamaraResponse.json();

    if (!tamaraResponse.ok || !tamaraData.checkout_url) {
      console.error("Tamara API error:", tamaraData);
      return new Response(
        JSON.stringify({ error: "Failed to create Tamara session" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update order
    await supabaseAdmin
      .from("orders")
      .update({
        payment_gateway_id: tamaraData.order_id,
        payment_status: "processing",
      })
      .eq("order_ref", order_ref);

    return new Response(
      JSON.stringify({
        success: true,
        payment_url: tamaraData.checkout_url,
        tamara_order_id: tamaraData.order_id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Tamara checkout error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

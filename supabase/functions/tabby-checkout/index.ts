// Mainspring Dubai — Tabby Checkout Edge Function
// Creates a Tabby checkout session server-side.
// Deploy: supabase functions deploy tabby-checkout
//
// SETUP:
// 1. Apply for merchant account at tabby.ai/business
// 2. Get your Merchant Code and Secret Key
// 3. Set secrets:
//    supabase secrets set TABBY_SECRET_KEY=sk_xxxxx
//    supabase secrets set TABBY_MERCHANT_CODE=your_merchant_code
//    supabase secrets set SITE_URL=https://mainspringdxb.com

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

    const TABBY_SECRET_KEY = Deno.env.get("TABBY_SECRET_KEY");
    const TABBY_MERCHANT_CODE = Deno.env.get("TABBY_MERCHANT_CODE");
    const SITE_URL = Deno.env.get("SITE_URL") || "https://mainspringdxb.com";

    if (!TABBY_SECRET_KEY || !TABBY_MERCHANT_CODE) {
      return new Response(
        JSON.stringify({ error: "Tabby not configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Create Tabby Checkout Session ---
    const tabbyResponse = await fetch("https://api.tabby.ai/api/v2/checkout", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TABBY_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payment: {
          amount: String(order.total_aed),
          currency: "AED",
          description: `Mainspring Dubai Order ${order.order_ref}`,
          buyer: {
            phone: order.customer_phone,
            email: order.customer_email || "customer@mainspringdxb.com",
            name: order.customer_name,
          },
          order: {
            reference_id: order.order_ref,
            items: order.items.map((item: any) => ({
              title: `${item.brand} ${item.name}`,
              quantity: item.qty,
              unit_price: String(item.price),
              category: "Watches",
            })),
          },
          buyer_history: {
            registered_since: new Date().toISOString(),
            loyalty_level: 0,
          },
          shipping_address: {
            city: "Dubai",
            address: order.customer_address || "Dubai, UAE",
            zip: "00000",
          },
        },
        lang: "en",
        merchant_code: TABBY_MERCHANT_CODE,
        merchant_urls: {
          success: `${SITE_URL}?order=${order.order_ref}&status=tabby_success`,
          cancel: `${SITE_URL}?order=${order.order_ref}&status=tabby_cancel`,
          failure: `${SITE_URL}?order=${order.order_ref}&status=tabby_failure`,
        },
      }),
    });

    const tabbyData = await tabbyResponse.json();

    if (!tabbyResponse.ok) {
      console.error("Tabby API error:", tabbyData);
      return new Response(
        JSON.stringify({ error: "Failed to create Tabby session" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find the installments payment option URL
    const installmentOption = tabbyData.configuration?.available_products?.installments?.[0];
    const checkoutUrl = installmentOption?.web_url || tabbyData.configuration?.available_products?.installments?.[0]?.web_url;

    if (!checkoutUrl) {
      console.error("No Tabby checkout URL:", tabbyData);
      return new Response(
        JSON.stringify({ error: "Tabby payment not available for this order" }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update order
    await supabaseAdmin
      .from("mainspring_orders")
      .update({
        payment_gateway_id: tabbyData.id,
        payment_status: "processing",
      })
      .eq("order_ref", order_ref);

    return new Response(
      JSON.stringify({
        success: true,
        payment_url: checkoutUrl,
        session_id: tabbyData.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Tabby checkout error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

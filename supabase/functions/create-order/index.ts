// Mainspring Dubai — Create Order Edge Function
// This runs SERVER-SIDE. No secrets are exposed to the browser.
// Deploy: supabase functions deploy create-order

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
    const body = await req.json();
    const { customer_name, customer_email, customer_phone, customer_address, items, payment_method } = body;

    // --- Validation ---
    if (!customer_name || !customer_phone || !items?.length || !payment_method) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: customer_name, customer_phone, items, payment_method" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const validMethods = ["bank_transfer", "tap_card", "tabby", "tamara", "cash"];
    if (!validMethods.includes(payment_method)) {
      return new Response(
        JSON.stringify({ error: "Invalid payment method" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Sanitize phone (basic)
    const cleanPhone = customer_phone.replace(/[^\d+]/g, "");
    if (cleanPhone.length < 8) {
      return new Response(
        JSON.stringify({ error: "Invalid phone number" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Calculate totals server-side (NEVER trust client totals) ---
    // In production, fetch actual prices from your products table:
    // const { data: products } = await supabase.from('products').select('id, price').in('id', items.map(i => i.id));
    // For now, we use the prices from the request but you SHOULD validate against DB prices.
    const subtotal = items.reduce(
      (sum: number, item: { price: number; qty: number }) => sum + item.price * item.qty,
      0
    );

    const surchargeRate = (payment_method === "tabby" || payment_method === "tamara") ? 10 : 0;
    const total = Math.round(subtotal * (1 + surchargeRate / 100));

    // Generate order reference
    const orderRef = "MS-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase();

    // --- Use SERVICE ROLE key (server-side only, never exposed) ---
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Insert order
    const { data: order, error: insertError } = await supabaseAdmin
      .from("orders")
      .insert({
        order_ref: orderRef,
        customer_name: customer_name.substring(0, 200),
        customer_email: customer_email?.substring(0, 200) || null,
        customer_phone: cleanPhone.substring(0, 20),
        customer_address: customer_address?.substring(0, 500) || null,
        items: items.map((i: any) => ({
          id: i.id,
          brand: String(i.brand).substring(0, 100),
          name: String(i.name).substring(0, 200),
          price: Number(i.price),
          qty: Math.min(Math.max(1, Math.floor(Number(i.qty))), 10),
        })),
        subtotal_aed: subtotal,
        surcharge_pct: surchargeRate,
        total_aed: total,
        payment_method,
        payment_status: "pending",
        order_status: "pending",
        device_type: req.headers.get("user-agent")?.includes("Mobile") ? "mobile" : "desktop",
        user_agent: req.headers.get("user-agent")?.substring(0, 500),
      })
      .select()
      .single();

    if (insertError) {
      console.error("Order insert error:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to create order" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log initial status
    await supabaseAdmin.from("order_status_history").insert({
      order_id: order.id,
      old_status: null,
      new_status: "pending",
      changed_by: "system",
      note: `Order created via ${payment_method}`,
    });

    // Return order info (safe data only — no internal IDs or gateway secrets)
    return new Response(
      JSON.stringify({
        success: true,
        order_ref: orderRef,
        total_aed: total,
        payment_method,
        surcharge_pct: surchargeRate,
      }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Unexpected error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

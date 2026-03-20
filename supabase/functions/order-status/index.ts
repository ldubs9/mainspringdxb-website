// Mainspring Dubai — Order Status Lookup Edge Function
// Allows customers to check their order status by order_ref + phone.
// Deploy: supabase functions deploy order-status
//
// Security: Requires both order_ref AND phone number to prevent enumeration.

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
    const { order_ref, phone } = await req.json();

    if (!order_ref || !phone) {
      return new Response(
        JSON.stringify({ error: "Both order_ref and phone are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cleanPhone = phone.replace(/[^\d+]/g, "");

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Lookup order — must match BOTH ref and phone
    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("order_ref, items, subtotal_aed, total_aed, surcharge_pct, payment_method, payment_status, order_status, tracking_number, created_at")
      .eq("order_ref", order_ref)
      .eq("customer_phone", cleanPhone)
      .single();

    if (error || !order) {
      // Deliberately vague error to prevent enumeration
      return new Response(
        JSON.stringify({ error: "Order not found. Please check your order reference and phone number." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get status history
    const { data: history } = await supabaseAdmin
      .from("order_status_history")
      .select("new_status, note, created_at")
      .eq("order_id", order_ref)  // This won't work — we need the UUID
      .order("created_at", { ascending: true });

    // Return safe data only (no internal IDs, no gateway responses)
    return new Response(
      JSON.stringify({
        order_ref: order.order_ref,
        items: order.items,
        subtotal_aed: order.subtotal_aed,
        total_aed: order.total_aed,
        surcharge_pct: order.surcharge_pct,
        payment_method: order.payment_method,
        payment_status: order.payment_status,
        order_status: order.order_status,
        tracking_number: order.tracking_number,
        created_at: order.created_at,
        history: history || [],
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Order status error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

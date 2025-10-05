// backend/server.js
import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import cors from "cors";

import filesRouter from "./routes/files.js";
import hooksRouter from "./routes/hooks.js"; // <-- NEW

// Helper to notify your Apps Script on failures
async function notifyAppsScriptPaymentFailed(payload) {
  const url = process.env.APPS_SCRIPT_URL; // e.g. your deployed Web App URL
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "PAYMENT_FAILED", ...payload }),
    });
  } catch (e) {
    console.warn("[apps-script] notify failed:", e?.message || e);
  }
}

const app = express();

/**
 * CORS
 * Add your production domain(s) to the origin array.
 */
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://printora.it",
      "https://www.printora.it",
    "https://printora.it",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    // include X-Relay-Token so browser can send it if needed (Make filter reads it from the relay)
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Relay-Token"],
  })
);
app.options("*", cors()); // Preflight for all routes

/**
 * Stripe init
 */
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY missing");
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});
const PMC_ID = process.env.STRIPE_PMC_ID;
/**
 * Route-scoped parser BEFORE global parsers for Stripe Checkout creation
 */
app.post(
  "/api/create-checkout-session",
  express.json({ limit: "2mb" }),
  async (req, res) => {
    try {
      const { amount, items = [], shippingAddress, metadata = {} } = req.body;

      if (typeof amount !== "number" || !(amount > 0)) {
        return res.status(400).json({ error: "Amount must be a positive number" });
      }

      const isDevelopment = process.env.NODE_ENV !== "production";
      const baseUrl = isDevelopment
        ? "http://localhost:5173"
        : (process.env.FRONTEND_URL || "https://printora.it");      

        if (req.body.order_id && !meta.order_id) meta.order_id = String(req.body.order_id);
        if (req.body.order_code && !meta.order_code) meta.order_code = String(req.body.order_code);

        const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "Order from Printora",
              description: `Order containing ${items?.length || 0} items`,
            },
            unit_amount: Math.round(amount * 100), // cents
          },
          quantity: 1,
        },
        ],
        success_url: `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/payment-cancel`,
        locale: "auto",
        billing_address_collection: "auto",
        ...(shippingAddress?.email && { customer_email: shippingAddress.email }),
        // Use the config that has PayPal enabled (falls back silently if not set)
        ...(PMC_ID ? { payment_method_configuration: PMC_ID } : {}),
            metadata: {
              item_count: String(items?.length || 0),
              order_total: String(amount),
              ...metadata,
          },
      });
          

      console.log("Checkout session created successfully:", session.id);
      return res.json({ id: session.id, url: session.url });
    } catch (err) {
      console.error("Create checkout session failed:", err);
      return res.status(500).json({
        error: err?.message || "Stripe error",
        type: err?.type || "stripe_error",
        details: process.env.NODE_ENV === "development" ? err.stack : undefined,
      });
    }
  }
);

// Stripe Webhook (must use raw body!)
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET; // from your Stripe Dashboard

    let event;
    try {
      if (whSecret) {
        event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
      } else {
        // If you don't set a secret (not recommended), accept as-is
        event = JSON.parse(req.body.toString("utf8"));
      }
    } catch (err) {
      console.error("[stripe-webhook] signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const md = pi.metadata || {};
          await notifyAppsScriptPaymentFailed({
            id: md.order_id || null,
            order_code: md.order_code || null,
            payment_details: {
              type: "payment_intent",
              id: pi.id,
              last_payment_error: pi.last_payment_error?.message || null,
              status: pi.status,
              amount: pi.amount,
              currency: pi.currency,
            },
          });
          break;
        }

        case "checkout.session.async_payment_failed":
        case "checkout.session.expired": {
          const cs = event.data.object;
          const md = cs.metadata || {};
          await notifyAppsScriptPaymentFailed({
            id: md.order_id || null,
            order_code: md.order_code || null,
            payment_details: {
              type: "checkout_session",
              id: cs.id,
              status: cs.status,
              payment_status: cs.payment_status,
              amount_total: cs.amount_total,
              currency: cs.currency,
            },
          });
          break;
        }

        default:
          // ignore others
          break;
      }

      res.json({ received: true });
    } catch (e) {
      console.error("[stripe-webhook] handler error:", e);
      res.status(500).json({ error: "handler error" });
    }
  }
);

// TEMP test route (remove in production)
app.post("/api/test-payment-failed", express.json(), async (req, res) => {
  const payload = {
    id: req.body.id || 9999,
    order_code: req.body.order_code || "ORD-9999",
    payment_details: {
      type: "checkout_session",
      id: "cs_test_123",
      status: "expired",
      payment_status: "unpaid",
      amount_total: 1234,
      currency: "eur",
    },
  };
  await notifyAppsScriptPaymentFailed(payload);
  res.json({ ok: true, forwarded: payload });
});

/**
 * Global parsers for the rest of the routes
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * Retrieve Checkout Session (expanded + line items; returns tidy summary)
 */
app.get("/api/checkout-session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "customer", "total_details.breakdown"],
    });

    const liResp = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      expand: ["data.price.product"],
    });

    const result = {
      id: session.id,
      payment_status: session.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      status: session.status, // 'complete' | 'open' | 'expired'
      amount_total: session.amount_total, // cents
      amount_subtotal: session.amount_subtotal, // cents
      currency: session.currency,
      customer_email: session.customer_details?.email || session.customer_email || null,
      total_details: session.total_details || null,
      shipping_cost: session.shipping_cost || null,
      line_items: (liResp.data || []).map((li) => ({
        description: li.description,
        quantity: li.quantity,
        amount_total: li.amount_total, // cents
        amount_subtotal: li.amount_subtotal, // cents
        price: li.price?.unit_amount ?? null,
        currency: li.price?.currency ?? session.currency,
      })),
      metadata: session.metadata || {},
    };

    return res.json(result);
  } catch (err) {
    console.error("Error retrieving session:", err);
    return res.status(500).json({
      error:
        err?.message ||
        "Failed to retrieve Stripe session. Check that your test/live keys match the session.",
    });
  }
});

/**
 * Files API
 */
app.use("/api/files", filesRouter);

/**
 * Hooks relay API  <-- NEW
 */
app.use("/api/hooks", hooksRouter);

/**
 * Health Check
 */
app.get("/api/health", (req, res) => {
  const makeConfigured = !!process.env.MAKE_ORDER_CREATED_WEBHOOK_URL;
  const webhookTokenConfigured = !!process.env.WEBHOOK_RELAY_TOKEN;
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    stripe_configured: !!process.env.STRIPE_SECRET_KEY,
    drive_configured:
      !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH &&
      !!process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID &&
      !!process.env.DRIVE_STAGING_FOLDER_ID,
    make_configured: makeConfigured,
    webhook_token_configured: webhookTokenConfigured,
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`📝 Stripe API Version: 2024-06-20`);
  console.log(
    `🔑 Stripe Key Type: ${
      process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "LIVE" : "TEST"
    }`
  );
  if (!process.env.MAKE_ORDER_CREATED_WEBHOOK_URL) {
    console.warn("⚠️  MAKE_ORDER_CREATED_WEBHOOK_URL is not set");
  }
  if (!process.env.WEBHOOK_RELAY_TOKEN) {
    console.warn("⚠️  WEBHOOK_RELAY_TOKEN is not set");
  }
});

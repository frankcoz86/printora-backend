// backend/server.js
import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import cors from "cors";
import http from "http";

import filesRouter from "./routes/files.js";
import hooksRouter from "./routes/hooks.js"; // <-- existing
import contactRouter from "./routes/contact.js"; // <-- NEW

// Helper to notify your Apps Script on failures
async function notifyAppsScriptPaymentFailed(payload) {
  const url = process.env.APPS_SCRIPT_URL;
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
 * CORS (put this first)
 * - Add your production domain(s) to origin
 * - Add a long maxAge so preflights are cached by the browser
 */
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://printora.it",
    "https://www.printora.it",
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Relay-Token"],
  maxAge: 86400, // cache preflight for 24h
};
app.use(cors(corsOptions));

/**
 * ⚡ FAST PATH for upload preflight:
 * Short-circuit OPTIONS on the upload route so it never touches other middleware.
 */
app.options("/api/files/upload", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": req.headers.origin || "https://www.printora.it",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Relay-Token",
    "Access-Control-Max-Age": "86400",
  });
  return res.status(204).end();
});

// Safety: still allow generic preflight for any other route
app.options("*", cors(corsOptions));

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
 * (your original ordering preserved)
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

      // NOTE: leaving your existing code style intact (no edits to logic):
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
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      if (whSecret) {
        event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
      } else {
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
 * 🚀 IMPORTANT: Mount the files router BEFORE global JSON/urlencoded parsers.
 * If filesRouter uses multer/busboy, this prevents body parsing overhead on big multipart uploads.
 */
app.use("/api/files", filesRouter);

/**
 * Global parsers for the rest of the routes
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

/**
 * Hooks relay API
 */
app.use("/api/hooks", hooksRouter);

/**
 * ✅ Contact API (NEW)
 *   - This is the JSON route your frontend calls: POST /api/contact
 *   - contactRouter handles GET ping, OPTIONS, and POST forwarding to Apps Script
 */
app.use("/api/contact", contactRouter);
console.log("[BOOT] contact router mounted at /api/contact");

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

// Create an HTTP server to tune timeouts (helps with larger uploads)
const server = http.createServer(app);

// Keep connections open long enough for cloud uploads
server.keepAliveTimeout = 65_000;  // > default 5s/15s on some hosts
server.headersTimeout   = 66_000;
server.requestTimeout   = 0;       // disable per-request timeout

server.listen(PORT, () => {
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

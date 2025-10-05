// backend/routes/hooks.js
import express from "express";

const router = express.Router();

const MAKE_URL = process.env.MAKE_ORDER_CREATED_WEBHOOK_URL || "";
const ENV_TOKEN = process.env.WEBHOOK_RELAY_TOKEN || "";

/**
 * Read the relay token from the incoming request headers (fallback to env).
 * Headers are lowercased by Node, but we defensively check both.
 */
function getRelayToken(req) {
  return (
    req.headers["x-relay-token"] ||
    req.headers["X-Relay-Token"] ||
    ENV_TOKEN ||
    ""
  ).toString().trim();
}

/**
 * POST /api/hooks/order-created
 * Body: { order_id: number|string }
 *
 * Relays to your Make (Integromat) "order-created" webhook and forwards a
 * shared secret header (X-Relay-Token) so your Make filter can validate it.
 */
router.post("/order-created", async (req, res) => {
  try {
    const { order_id } = req.body || {};
    if (!order_id && order_id !== 0) {
      return res.status(400).json({ error: "order_id is required" });
    }
    if (!MAKE_URL) {
      return res
        .status(500)
        .json({ error: "MAKE_ORDER_CREATED_WEBHOOK_URL is not set" });
    }

    const relayToken = getRelayToken(req);
    if (!relayToken) {
      // Not fatal to send, but your Make filter will likely block it.
      console.warn(
        "[hooks] No X-Relay-Token provided (neither header nor env). The Make filter may reject this call."
      );
    }

    // Timeout protection (8s)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(MAKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Relay-Token": relayToken,
      },
      body: JSON.stringify({ order_id }),
      signal: controller.signal,
    }).catch((e) => {
      throw new Error(`Make webhook fetch failed: ${e.message}`);
    });

    clearTimeout(timeout);

    const text = await resp.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!resp.ok) {
      return res.status(502).json({
        error: `Make webhook responded with ${resp.status}`,
        payload,
      });
    }

    return res.json({
      ok: true,
      order_id,
      make_response: payload,
    });
  } catch (e) {
    const message =
      e?.name === "AbortError"
        ? "Make webhook timed out"
        : e?.message || "Unknown error";
    console.error("[hooks] order-created relay error:", message);
    return res.status(500).json({ error: message });
  }
});

export default router;

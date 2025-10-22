import express from "express";

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function parseSmart(resp) {
  const ct = resp.headers.get("content-type") || "";
  const isJSON = ct.includes("application/json");
  try {
    return { isJSON, body: isJSON ? await resp.json() : await resp.text() };
  } catch {
    return { isJSON, body: null };
  }
}

// Ping + preflight (debug-friendly)
router.get("/", (_req, res) => res.json({ ok: true, method: "GET" }));
router.options("/", (_req, res) => res.sendStatus(204));

router.post("/", async (req, res) => {
  try {
    const { name, email, subject, message, order_code } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "Missing fields" });
    }
    if (!EMAIL_RE.test(String(email))) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }
    if (String(name).length > 200 || String(subject || "").length > 300) {
      return res.status(400).json({ ok: false, error: "Field too long" });
    }
    if (String(message).length > 5000) {
      return res.status(400).json({ ok: false, error: "Message too long" });
    }

    const url = process.env.APPS_SCRIPT_URL;
    if (!url) {
      return res.status(500).json({ ok: false, error: "APPS_SCRIPT_URL not configured" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          event: "CONTACT_MESSAGE",
          name,
          email,
          subject,
          message,
          order_code,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      console.error("[/api/contact] fetch to Apps Script failed:", err?.message || err);
      return res.status(502).json({ ok: false, error: "Upstream error (Apps Script unreachable)" });
    }
    clearTimeout(timeout);

    const { isJSON, body } = await parseSmart(resp);

    if (!resp.ok) {
      const snippet = isJSON
        ? JSON.stringify(body).slice(0, 300)
        : String(body || "").slice(0, 300);
      console.error("[/api/contact] Apps Script HTTP error:", resp.status, snippet);
      return res.status(502).json({
        ok: false,
        error: isJSON
          ? body?.error || body?.detail || `Apps Script HTTP ${resp.status}`
          : `Apps Script returned non-JSON (HTTP ${resp.status}). Snippet: ${snippet}`,
      });
    }

    if (isJSON && body && body.ok === false) {
      console.error("[/api/contact] Apps Script logical error:", body);
      return res.status(502).json({ ok: false, error: body.error || "Apps Script error" });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("contact route error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

export default router;

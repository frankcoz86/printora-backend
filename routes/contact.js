import express from "express";
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { name, email, subject, message, order_code } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ ok:false, error:"Missing fields" });
    }

    // Call your Apps Script web app
    const r = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "CONTACT_MESSAGE",
        name, email, subject, message, order_code
      })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Apps Script error");

    res.json({ ok:true });
  } catch (e) {
    console.error("contact route error:", e);
    res.status(500).json({ ok:false, error:"Server error" });
  }
});

export default router;

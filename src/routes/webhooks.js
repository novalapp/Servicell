const express = require("express");
const { processWebhookMessage } = require("../modules/webhooks/receiver");
const { META_VERIFY_TOKEN } = require("../config/env");

const router = express.Router();

// Verify webhook (GET request from Meta during setup)
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: "Verification failed" });
  }
});

// Receive webhook messages (POST request from Meta)
router.post("/webhook", async (req, res) => {
  try {
    const result = await processWebhookMessage(req.body);

    // Always respond with 200 to Meta, even if message wasn't processed
    // (e.g., if it's a status update instead of a message)
    res.status(200).json({ received: true, result });
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    res.status(200).json({ received: true, error: error.message });
  }
});

module.exports = router;

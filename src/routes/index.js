const express = require("express");
const healthRouter = require("./health");
const webhookRouter = require("./webhooks");

const router = express.Router();

router.use(healthRouter);
router.use(webhookRouter);

module.exports = router;

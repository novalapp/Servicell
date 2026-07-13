const express = require("express");
const healthRouter = require("./health");

const router = express.Router();

router.use(healthRouter);

module.exports = router;

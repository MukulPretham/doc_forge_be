import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getConfiguredProviders } from "../models/registry.js";
import { log } from "../logger.js";

const router = Router();

router.get("/", requireAuth, (_req, res) => {
  const providers = getConfiguredProviders();
  log.info(`models list by=${_req.user!.login} providers=${providers.map((p) => p.id).join(",")}`);
  res.json({ providers });
});

export default router;

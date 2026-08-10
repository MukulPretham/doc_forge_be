import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getConfiguredProviders } from "../models/registry.js";

const router = Router();

router.get("/", requireAuth, (_req, res) => {
  res.json({ providers: getConfiguredProviders() });
});

export default router;

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { log } from "./logger.js";
import authRoutes from "./routes/auth.js";
import conversationsRoutes from "./routes/conversations.js";
import modelsRoutes from "./routes/models.js";
import prsRoutes from "./routes/prs.js";
import reposRoutes from "./routes/repos.js";

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const user = (req as unknown as { user?: { login?: string } }).user;
    log.http(req.method, req.originalUrl, res.statusCode, Date.now() - start, user?.login);
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "docforge-backend" });
});

app.use("/auth", authRoutes);
app.use("/repos", reposRoutes);
app.use("/models", modelsRoutes);
app.use("/conversations", conversationsRoutes);
app.use("/prs", prsRoutes);

app.listen(config.PORT, () => {
  log.ok(`docforge-backend listening on http://localhost:${config.PORT}`);
});

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import authRoutes from "./routes/auth.js";

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "docforge-backend" });
});

app.use("/auth", authRoutes);

app.listen(config.PORT, () => {
  console.log(`🚀 docforge-backend listening on http://localhost:${config.PORT}`);
});

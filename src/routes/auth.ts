import { Router } from "express";
import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { prisma } from "../db/prisma.js";
import { encrypt } from "../github/crypto.js";
import { exchangeCode, getOAuthURL } from "../github/oauth.js";
import {
  createSessionToken,
  hashToken,
  requireAuth,
  SESSION_COOKIE,
  sessionExpiry,
} from "../middleware/auth.js";

const router = Router();
const STATE_COOKIE = "df_oauth_state";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

router.get("/github", (_req, res) => {
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    return res.status(503).json({ error: "GitHub OAuth not configured on the server" });
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 10 * 60 * 1000 });
  res.redirect(getOAuthURL(state));
});

router.get("/github/callback", async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies[STATE_COOKIE];

  res.clearCookie(STATE_COOKIE);

  if (typeof code !== "string" || typeof state !== "string" || state !== savedState) {
    return res.redirect(`${config.FRONTEND_URL}/?error=invalid_oauth_state`);
  }

  try {
    const { accessToken } = await exchangeCode(code);
    const octokit = new Octokit({ auth: accessToken });
    const { data: ghUser } = await octokit.rest.users.getAuthenticated();

    const user = await prisma.user.upsert({
      where: { githubId: String(ghUser.id) },
      update: {
        login: ghUser.login,
        name: ghUser.name,
        email: ghUser.email,
        avatarUrl: ghUser.avatar_url,
        accessToken: encrypt(accessToken),
      },
      create: {
        githubId: String(ghUser.id),
        login: ghUser.login,
        name: ghUser.name,
        email: ghUser.email,
        avatarUrl: ghUser.avatar_url,
        accessToken: encrypt(accessToken),
      },
    });

    const sessionToken = createSessionToken();
    await prisma.session.create({
      data: { userId: user.id, tokenHash: hashToken(sessionToken), expiresAt: sessionExpiry() },
    });

    res.cookie(SESSION_COOKIE, sessionToken, { httpOnly: true, sameSite: "lax", maxAge: TTL_MS });
    res.redirect(`${config.FRONTEND_URL}/chat`);
  } catch (err) {
    console.error("OAuth callback failed:", err);
    res.redirect(`${config.FRONTEND_URL}/?error=oauth_failed`);
  }
});

router.get("/me", requireAuth, (req, res) => {
  const { id, login, name, email, avatarUrl } = req.user!;
  res.json({ id, login, name, email, avatarUrl });
});

router.post("/logout", requireAuth, async (req, res) => {
  await prisma.session.delete({ where: { id: req.session!.id } }).catch(() => {});
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

export default router;

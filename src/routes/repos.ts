import { Router } from "express";
import { getOctokit } from "../github/client.js";
import { log } from "../logger.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const octokit = getOctokit(req.user!.accessToken);
    const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      per_page: 100,
      sort: "updated",
      visibility: "all",
    });

    log.info(`repos list by=${req.user!.login} count=${repos.length}`);

    res.json(
      repos.map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        owner: r.owner.login,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        language: r.language,
        updatedAt: r.updated_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;

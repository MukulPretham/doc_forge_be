import { Router } from "express";
import { getOctokit } from "../github/client.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../db/prisma.js";

const router = Router();

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const pullRequests = await prisma.pullRequest.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
    });

    const octokit = getOctokit(req.user!.accessToken);

    const refreshed = await Promise.all(
      pullRequests.map(async (pr) => {
        try {
          const { data } = await octokit.rest.pulls.get({
            owner: pr.repoOwner,
            repo: pr.repoName,
            pull_number: pr.number,
          });
          const state = data.state ?? pr.state;
          if (state !== pr.state) {
            await prisma.pullRequest.update({
              where: { id: pr.id },
              data: { state, title: data.title ?? pr.title },
            });
          }
          return {
            id: pr.id,
            repoOwner: pr.repoOwner,
            repoName: pr.repoName,
            number: pr.number,
            url: data.html_url ?? pr.url,
            branch: pr.branch,
            title: data.title ?? pr.title,
            state,
            createdAt: pr.createdAt,
          };
        } catch (err) {
          return {
            id: pr.id,
            repoOwner: pr.repoOwner,
            repoName: pr.repoName,
            number: pr.number,
            url: pr.url,
            branch: pr.branch,
            title: pr.title,
            state: pr.state,
            createdAt: pr.createdAt,
            stale: true,
          };
        }
      }),
    );

    res.json({ pullRequests: refreshed });
  } catch (err) {
    next(err);
  }
});

export default router;

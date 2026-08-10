import { Octokit } from "@octokit/rest";
import { decrypt } from "./crypto.js";

export function getOctokit(encryptedToken: string): Octokit {
  return new Octokit({ auth: decrypt(encryptedToken) });
}

import { config } from "../config.js";

const GITHUB_OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN = "https://github.com/login/oauth/access_token";

export function getOAuthURL(state: string): string {
  const params = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID!,
    redirect_uri: config.GITHUB_REDIRECT_URI,
    scope: "repo read:user",
    state,
  });
  return `${GITHUB_OAUTH_AUTHORIZE}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<{ accessToken: string }> {
  const response = await fetch(GITHUB_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: config.GITHUB_CLIENT_ID,
      client_secret: config.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: config.GITHUB_REDIRECT_URI,
    }),
  });

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "Failed to exchange OAuth code");
  }

  return { accessToken: data.access_token };
}

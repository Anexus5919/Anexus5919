/**
 * Renders the GitHub stats card as a static SVG.
 *
 * The upstream github-readme-stats service packs every stat into a single
 * GraphQL request. This account is active enough (1000+ PRs, 900+ issues)
 * that the combined query exceeds GitHub's per-query resource budget and is
 * rejected outright. Each field succeeds on its own, so this fetches them one
 * at a time and degrades gracefully if any single stat fails.
 */

const USERNAME = process.env.USERNAME;
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = process.env.OUT || "profile/stats.svg";

if (!USERNAME || !TOKEN) {
  console.error("USERNAME and GITHUB_TOKEN are required");
  process.exit(1);
}

const THEME = {
  title: "#70a5fd",
  icon: "#bf91f3",
  text: "#38bdae",
  bg: "#1a1b27",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a GraphQL query, retrying on transient failures and on the resource
 * limiter (whose budget refills over time).
 */
async function gql(query, attempt = 1) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-card",
    },
    body: JSON.stringify({ query }),
  });

  const body = await res.json().catch(() => null);
  const limited = body?.errors?.some((e) => e.type === "RESOURCE_LIMITS_EXCEEDED");

  if ((!res.ok || body?.errors) && attempt < 4) {
    await sleep(limited ? 5000 * attempt : 1500 * attempt);
    return gql(query, attempt + 1);
  }
  if (body?.errors) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

/** Fetches one stat, returning null instead of throwing so one failure can't sink the card. */
async function stat(name, query, pick) {
  try {
    const value = pick(await gql(query));
    console.log(`  ${name}: ${value}`);
    return value;
  } catch (err) {
    console.error(`  ${name}: FAILED (${err.message})`);
    return null;
  }
}

const u = `user(login: "${USERNAME}")`;

console.log(`Fetching stats for ${USERNAME}...`);

// Sequential on purpose: parallel requests share the same resource budget and
// trip the limiter, which is the exact failure this script exists to avoid.
const commits = await stat(
  "commits",
  `{ ${u} { contributionsCollection { totalCommitContributions } } }`,
  (d) => d.user.contributionsCollection.totalCommitContributions,
);

const privateCommits = await stat(
  "private commits",
  `{ ${u} { contributionsCollection { restrictedContributionsCount } } }`,
  (d) => d.user.contributionsCollection.restrictedContributionsCount,
);

const prs = await stat(
  "PRs",
  `{ ${u} { pullRequests(first: 1) { totalCount } } }`,
  (d) => d.user.pullRequests.totalCount,
);

const openIssues = await stat(
  "open issues",
  `{ ${u} { issues(states: OPEN) { totalCount } } }`,
  (d) => d.user.issues.totalCount,
);

const closedIssues = await stat(
  "closed issues",
  `{ ${u} { issues(states: CLOSED) { totalCount } } }`,
  (d) => d.user.issues.totalCount,
);

const followers = await stat(
  "followers",
  `{ ${u} { followers { totalCount } } }`,
  (d) => d.user.followers.totalCount,
);

const reviews = await stat(
  "reviews",
  `{ ${u} { contributionsCollection { totalPullRequestReviewContributions } } }`,
  (d) => d.user.contributionsCollection.totalPullRequestReviewContributions,
);

const repoData = await stat(
  "repos/stars",
  `{ ${u} { repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}) { totalCount nodes { stargazers { totalCount } } } } }`,
  (d) => d.user.repositories,
);

const contributedTo = await stat(
  "contributed to",
  `{ ${u} { repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount } } }`,
  (d) => d.user.repositoriesContributedTo.totalCount,
);

const stars = repoData
  ? repoData.nodes.reduce((sum, r) => sum + r.stargazers.totalCount, 0)
  : null;
const totalCommits =
  commits === null ? null : commits + (privateCommits ?? 0);
const totalIssues =
  openIssues === null && closedIssues === null
    ? null
    : (openIssues ?? 0) + (closedIssues ?? 0);

// A card with no data at all is worse than leaving the previous one in place.
if ([totalCommits, prs, totalIssues, stars].every((v) => v === null)) {
  console.error("Every stat failed; refusing to overwrite the existing card.");
  process.exit(1);
}

// Upstream's rank algorithm, so the badge matches what GRS would have shown.
const exponential_cdf = (x) => 1 - 2 ** -x;
const log_normal_cdf = (x) => x / (1 + x);

function calculateRank({ commits, prs, issues, reviews, stars, followers }) {
  const COMMITS_MEDIAN = 250, COMMITS_WEIGHT = 2;
  const PRS_MEDIAN = 50, PRS_WEIGHT = 3;
  const ISSUES_MEDIAN = 25, ISSUES_WEIGHT = 1;
  const REVIEWS_MEDIAN = 2, REVIEWS_WEIGHT = 1;
  const STARS_MEDIAN = 50, STARS_WEIGHT = 4;
  const FOLLOWERS_MEDIAN = 10, FOLLOWERS_WEIGHT = 1;

  const TOTAL_WEIGHT =
    COMMITS_WEIGHT + PRS_WEIGHT + ISSUES_WEIGHT +
    REVIEWS_WEIGHT + STARS_WEIGHT + FOLLOWERS_WEIGHT;

  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];

  const rank =
    1 -
    (COMMITS_WEIGHT * exponential_cdf(commits / COMMITS_MEDIAN) +
      PRS_WEIGHT * exponential_cdf(prs / PRS_MEDIAN) +
      ISSUES_WEIGHT * exponential_cdf(issues / ISSUES_MEDIAN) +
      REVIEWS_WEIGHT * exponential_cdf(reviews / REVIEWS_MEDIAN) +
      STARS_WEIGHT * log_normal_cdf(stars / STARS_MEDIAN) +
      FOLLOWERS_WEIGHT * log_normal_cdf(followers / FOLLOWERS_MEDIAN)) /
      TOTAL_WEIGHT;

  return {
    level: LEVELS[THRESHOLDS.findIndex((t) => rank * 100 <= t)],
    percentile: rank * 100,
  };
}

const rank = calculateRank({
  commits: totalCommits ?? 0,
  prs: prs ?? 0,
  issues: totalIssues ?? 0,
  reviews: reviews ?? 0,
  stars: stars ?? 0,
  followers: followers ?? 0,
});

// Trimmed from upstream's icon set; one per row we render.
const PATHS = {
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z",
  commit: "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  issue: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  contrib: "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z",
};

const rows = [
  stars !== null && { icon: "star", label: "Total Stars Earned", value: stars },
  totalCommits !== null && { icon: "commit", label: "Total Commits", value: totalCommits },
  prs !== null && { icon: "pr", label: "Total PRs", value: prs },
  totalIssues !== null && { icon: "issue", label: "Total Issues", value: totalIssues },
  contributedTo !== null && { icon: "contrib", label: "Contributed to (last year)", value: contributedTo },
].filter(Boolean);

const HEIGHT = Math.max(195, 45 + rows.length * 25 + 25);
const CIRCLE_LEN = 2 * Math.PI * 40;
const offset = CIRCLE_LEN - (rank.percentile / 100) * CIRCLE_LEN;

const rowSvg = rows
  .map(
    (r, i) => `
    <g transform="translate(0, ${i * 25})">
      <svg x="0" y="0" viewBox="0 0 16 16" width="16" height="16" fill="${THEME.icon}">
        <path d="${PATHS[r.icon]}"/>
      </svg>
      <text x="25" y="12.5" fill="${THEME.text}" font-size="14">${r.label}:</text>
      <text x="219" y="12.5" fill="${THEME.text}" font-size="14" font-weight="600" text-anchor="end">${r.value.toLocaleString("en-US")}</text>
    </g>`,
  )
  .join("");

const svg = `<svg width="495" height="${HEIGHT}" viewBox="0 0 495 ${HEIGHT}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${USERNAME}'s GitHub Stats">
  <title>${USERNAME}'s GitHub Stats</title>
  <style>
    .header { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; }
    text { font-family: 'Segoe UI', Ubuntu, Sans-Serif; }
    .rank-text { font: 800 24px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${THEME.title}; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="494" height="${HEIGHT - 1}" fill="${THEME.bg}" stroke="none"/>
  <g transform="translate(25, 35)">
    <text class="header">${USERNAME}'s GitHub Stats</text>
  </g>
  <g transform="translate(0, 55)">
    <g transform="translate(400, ${(HEIGHT - 55) / 2 - 10})">
      <circle cx="0" cy="0" r="40" stroke="${THEME.title}" stroke-width="6" fill="none" opacity="0.2"/>
      <circle cx="0" cy="0" r="40" stroke="${THEME.title}" stroke-width="6" fill="none"
        stroke-dasharray="${CIRCLE_LEN}" stroke-dashoffset="${offset}"
        stroke-linecap="round" transform="rotate(-90)"/>
      <text class="rank-text" text-anchor="middle" dominant-baseline="central">${rank.level}</text>
    </g>
    <g transform="translate(25, 0)">${rowSvg}
    </g>
  </g>
</svg>
`;

const { writeFile, mkdir } = await import("node:fs/promises");
const { dirname } = await import("node:path");
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, svg);
console.log(`Wrote ${OUT} (rank ${rank.level}, ${rows.length} rows)`);

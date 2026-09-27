/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://github.com/sajadinmaker/bugbee",

  // GitHub
  github: {
    repoUrl: "https://github.com/sajadinmaker/bugbee",
    starsFormatted: {
      compact: "160K",
      full: "160,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/bugbee",
    discord: "https://discord.gg/bugbee",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "900",
    commits: "13,000",
    monthlyUsers: "7.5M",
  },
} as const

// Validate core environment variables needed for the server to start
// Component-specific variables (Claude, Meta) are validated by their respective modules
function validateEnvironment() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
        `Please check your .env file and ensure all required variables are set.`
    );
  }
}

module.exports = validateEnvironment;

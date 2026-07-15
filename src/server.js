require("dotenv").config();

console.log(process.env.SUPABASE_URL);
console.log("Using Supabase:", process.env.SUPABASE_URL);

// Diagnostic logs
console.log("=== DIAGNOSTIC INFO ===");
console.log("CWD:", process.cwd());
console.log(".env exists:", require("fs").existsSync(".env"));
console.log(".env path (absolute):", require("path").resolve(".env"));
console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "OK (set)" : "NO (not set)");
console.log("SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "OK (set)" : "NO (not set)");
console.log("=======================\n");

// Validate environment variables BEFORE loading other modules
const validateEnvironment = require("./utils/validate-env");
validateEnvironment();

const app = require("./app");
const { PORT } = require("./config/env");

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

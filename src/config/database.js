const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require("./env");

// Environment variables are validated in src/server.js before this module is loaded
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

module.exports = supabase;
// Force schema refresh
supabase.from("messages").select("id").limit(1).then(() => {
  console.log("✅ Schema cache refreshed");
}).catch(() => {
  console.log("Schema refresh attempt completed");
});
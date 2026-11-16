// Labr instance. Separate pm2 name and directory (own users.db) from claudetaur.
// kill_timeout must exceed SHUTDOWN_GRACE_MS (10 s, shutdown.js) so an in-flight
// payout can finish before pm2 kills the process.
module.exports = {
  apps: [{ name: 'labr', script: 'bot.js', cwd: __dirname, kill_timeout: 15000 }],
};

// PM2 process configuration for AP & Partners Timesheet server.
// PM2 will keep this Node.js app running 24x7, auto-restart on crash,
// and resurrect it after a Windows reboot (via the scheduled task we install).
module.exports = {
  apps: [
    {
      name: 'ap-timesheet',
      script: 'server.js',
      cwd: __dirname,

      // Run in normal (single-process) mode. SQLite + better-sqlite3 does NOT
      // support cluster mode safely, so we keep instances at 1.
      instances: 1,
      exec_mode: 'fork',

      // Auto-restart policy
      autorestart: true,
      watch: false,                 // do NOT watch files in production
      max_memory_restart: '512M',   // restart if it ever leaks past 512 MB
      restart_delay: 3000,          // wait 3s between restarts
      max_restarts: 50,             // give up after 50 fast crashes in a row

      // Environment — these override / supplement .env values
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },

      // Logging — rotated by PM2; files live in C:\ap-timesheet\logs\
      out_file: './logs/ap-timesheet-out.log',
      error_file: './logs/ap-timesheet-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};

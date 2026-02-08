module.exports = {
  apps: [
    {
      name: 'issuecommand',
      cwd: __dirname,
      script: 'bun',
      args: 'run src/index.ts',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      exp_backoff_restart_delay: 100,
      max_memory_restart: '512M',
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: 'production',
        HTTP_PORT: '3100',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};

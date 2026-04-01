module.exports = {
  apps: [
    {
      name: 'link-scanner',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: '/home/node/clawd/workspace/link-scanner',
      interpreter: 'none',
      env_file: '.env',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      out_file: '/home/node/clawd/workspace/link-scanner/logs/out.log',
      error_file: '/home/node/clawd/workspace/link-scanner/logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};

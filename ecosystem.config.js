// PM2 Ecosystem Configuration
// Start with: pm2 start ecosystem.config.js
// Monitor:    pm2 monit
// Logs:       pm2 logs nexus-ai
// Stop:       pm2 stop nexus-ai

export default {
  apps: [{
    name: 'nexus-ai',
    script: 'src/index.js',
    node_args: '--experimental-vm-modules',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: 'production'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/output.log',
    merge_logs: true,
    max_memory_restart: '500M'
  }]
};

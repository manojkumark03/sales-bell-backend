require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Turso DB setup
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Initialize database
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      device_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used DATETIME
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_slug TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      message TEXT,
      priority INTEGER DEFAULT 3,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (webhook_slug) REFERENCES webhooks(slug)
    )
  `);

  console.log('✅ Database initialized');
}

initDB().catch(console.error);

// WebSocket connections: Map<deviceId, WebSocket>
const connections = new Map();
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, request, deviceId) => {
  connections.set(deviceId, ws);
  console.log(`✅ Device connected: ${deviceId} (Total: ${connections.size})`);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('📨 Received message from device:', deviceId, msg);
      if (msg.type === 'register_slug') {
        const result = await registerWebhook(msg.slug, deviceId);
        ws.send(JSON.stringify({ type: 'slug_registered', slug: msg.slug, success: result }));
        console.log(`✅ Slug "${msg.slug}" registered for device ${deviceId}`);
      }
    } catch (err) {
      console.error('Error handling message:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    connections.delete(deviceId);
    console.log(`❌ Device disconnected: ${deviceId} (Total: ${connections.size})`);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// Heartbeat to keep connections alive
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeat);
});

// Register a webhook slug for a device
async function registerWebhook(slug, deviceId) {
  try {
    await db.execute({
      sql: `INSERT INTO webhooks (slug, device_id, last_used) 
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(slug) DO UPDATE SET device_id = ?, last_used = CURRENT_TIMESTAMP`,
      args: [slug, deviceId, deviceId]
    });
    console.log(`✅ Webhook registered: ${slug} -> ${deviceId}`);
  } catch (err) {
    console.error('Error registering webhook:', err);
    throw err;
  }
}

// Send notification to device
async function sendNotification(slug, data) {
  try {
    // Get device ID for this slug
    const result = await db.execute({
      sql: 'SELECT device_id FROM webhooks WHERE slug = ?',
      args: [slug]
    });

    if (result.rows.length === 0) {
      return { success: false, error: 'Webhook not found' };
    }

    const deviceId = result.rows[0].device_id;
    const ws = connections.get(deviceId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'Device not connected' };
    }

    // Save notification to DB
    await db.execute({
      sql: `INSERT INTO notifications (webhook_slug, title, subtitle, message, priority)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        slug,
        data.title || 'Sales Bell',
        data.subtitle || '',
        data.message || 'New notification',
        data.priority || 3
      ]
    });

    // Update last_used
    await db.execute({
      sql: 'UPDATE webhooks SET last_used = CURRENT_TIMESTAMP WHERE slug = ?',
      args: [slug]
    });

    // Send to device
    ws.send(JSON.stringify({
      type: 'notification',
      title: data.title || 'Sales Bell',
      subtitle: data.subtitle || '',
      message: data.message || 'New notification',
      priority: data.priority || 3,
      timestamp: new Date().toISOString()
    }));

    return { success: true };
  } catch (err) {
    console.error('Error sending notification:', err);
    return { success: false, error: err.message };
  }
}

// Routes
app.get('/', (req, res) => {
  res.json({
    name: 'Sales Bell API',
    status: 'ok',
    connections: connections.size,
    docs: 'POST /w/your-slug with JSON body: { "message": "💰 $299!" }'
  });
});

// Main webhook endpoint - POST /w/your-custom-slug
app.post('/w/:slug', async (req, res) => {
  const { slug } = req.params;
  const data = {
    title: req.body.title,
    subtitle: req.body.subtitle,
    message: req.body.message || req.query.message || '💰 New sale!',
    priority: req.body.priority || 3
  };

  const result = await sendNotification(slug, data);

  if (result.success) {
    res.json({ success: true, message: 'Notification sent' });
  } else {
    res.status(result.error === 'Webhook not found' ? 404 : 503).json({
      success: false,
      error: result.error
    });
  }
});

// GET version for testing
app.get('/w/:slug', async (req, res) => {
  const { slug } = req.params;
  const message = req.query.message || req.query.m || '💰 Test notification!';

  const result = await sendNotification(slug, { message });

  if (result.success) {
    res.send(`✅ Notification sent to "${slug}": ${message}`);
  } else {
    res.status(result.error === 'Webhook not found' ? 404 : 503)
      .send(`❌ Error: ${result.error}`);
  }
});

// Check if slug is available
app.get('/api/check-slug/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const result = await db.execute({
      sql: 'SELECT 1 FROM webhooks WHERE slug = ?',
      args: [slug]
    });
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get webhook info
app.get('/api/webhook/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const webhook = await db.execute({
      sql: 'SELECT slug, created_at, last_used FROM webhooks WHERE slug = ?',
      args: [slug]
    });

    if (webhook.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }

    const notifications = await db.execute({
      sql: `SELECT title, subtitle, message, created_at 
            FROM notifications 
            WHERE webhook_slug = ? 
            ORDER BY created_at DESC 
            LIMIT 10`,
      args: [slug]
    });

    res.json({
      webhook: webhook.rows[0],
      recent_notifications: notifications.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', connections: connections.size });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Sales Bell server running on port ${PORT}`);
});

// WebSocket upgrade handler
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  const match = url.pathname.match(/^\/ws\/(.+)$/);

  if (match) {
    const deviceId = match[1];
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, deviceId);
    });
  } else {
    socket.destroy();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
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

// Initialize database with updated schema
async function initDB() {
  // Webhooks table - links device_id to multiple slugs
  await db.execute(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      device_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Index for faster device_id lookups
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_device_id ON webhooks(device_id)
  `);

  // Notifications table - stores all notifications per slug
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_slug TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      message TEXT NOT NULL,
      icon TEXT,
      priority INTEGER DEFAULT 3,
      sound TEXT,
      image TEXT,
      on_click_link TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (webhook_slug) REFERENCES webhooks(slug) ON DELETE CASCADE
    )
  `);

  // Index for faster slug lookups
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_webhook_slug ON notifications(webhook_slug)
  `);

  console.log('✅ Database initialized');
}

initDB().catch(console.error);

// WebSocket connections: Map<deviceId, WebSocket>
const connections = new Map();
// Device subscriptions: Map<deviceId, Set<slug>>
const subscriptions = new Map();

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, request, deviceId) => {
  connections.set(deviceId, ws);
  console.log(`✅ Device connected: ${deviceId} (Total: ${connections.size})`);

  ws.isAlive = true;
  ws.deviceId = deviceId;
  ws.on('pong', () => { ws.isAlive = true; });

  // Load existing webhooks for this device
  loadDeviceWebhooks(deviceId).then(slugs => {
    if (slugs.length > 0) {
      subscriptions.set(deviceId, new Set(slugs));
      console.log(`📱 Device ${deviceId} has webhooks:`, slugs);
    }
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('📨 Message from device:', deviceId, msg);

      if (msg.type === 'register_slug') {
        const result = await registerWebhook(msg.slug, deviceId);
        ws.send(JSON.stringify({ 
          type: 'slug_registered', 
          slug: msg.slug, 
          success: result.success,
          error: result.error 
        }));
      } else if (msg.type === 'get_webhooks') {
        const webhooks = await getDeviceWebhooks(deviceId);
        ws.send(JSON.stringify({ 
          type: 'webhooks_list', 
          webhooks 
        }));
      } else if (msg.type === 'get_notifications') {
        const notifications = await getNotifications(msg.slug, msg.limit || 50);
        ws.send(JSON.stringify({ 
          type: 'notifications_list', 
          slug: msg.slug,
          notifications 
        }));
      } else if (msg.type === 'delete_webhook') {
        const result = await deleteWebhook(msg.slug, deviceId);
        ws.send(JSON.stringify({ 
          type: 'webhook_deleted', 
          slug: msg.slug,
          success: result.success 
        }));
      }
    } catch (err) {
      console.error('Error handling message:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    connections.delete(deviceId);
    subscriptions.delete(deviceId);
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

// Load existing webhooks for a device
async function loadDeviceWebhooks(deviceId) {
  try {
    const result = await db.execute({
      sql: 'SELECT slug FROM webhooks WHERE device_id = ?',
      args: [deviceId]
    });
    return result.rows.map(row => row.slug);
  } catch (err) {
    console.error('Error loading webhooks:', err);
    return [];
  }
}

// Get all webhooks for a device
async function getDeviceWebhooks(deviceId) {
  try {
    const result = await db.execute({
      sql: `SELECT slug, created_at, last_used,
            (SELECT COUNT(*) FROM notifications WHERE webhook_slug = webhooks.slug) as notification_count
            FROM webhooks WHERE device_id = ? ORDER BY created_at DESC`,
      args: [deviceId]
    });
    return result.rows;
  } catch (err) {
    console.error('Error getting webhooks:', err);
    return [];
  }
}

// Get notifications for a slug
async function getNotifications(slug, limit = 50) {
  try {
    const result = await db.execute({
      sql: `SELECT id, title, subtitle, message, icon, priority, sound, image, 
            on_click_link, created_at 
            FROM notifications 
            WHERE webhook_slug = ? 
            ORDER BY created_at DESC 
            LIMIT ?`,
      args: [slug, limit]
    });
    return result.rows;
  } catch (err) {
    console.error('Error getting notifications:', err);
    return [];
  }
}

// Register a webhook slug for a device
async function registerWebhook(slug, deviceId) {
  try {
    // Validate slug
    if (!slug || slug.length < 3 || slug.length > 50) {
      return { success: false, error: 'Slug must be 3-50 characters' };
    }

    if (!/^[a-z0-9_-]+$/.test(slug)) {
      return { success: false, error: 'Invalid slug format' };
    }

    // Check if slug exists
    const existing = await db.execute({
      sql: 'SELECT device_id FROM webhooks WHERE slug = ?',
      args: [slug]
    });

    if (existing.rows.length > 0) {
      if (existing.rows[0].device_id === deviceId) {
        return { success: true }; // Already owned by this device
      }
      return { success: false, error: 'Slug already taken' };
    }

    // Create webhook
    await db.execute({
      sql: 'INSERT INTO webhooks (slug, device_id) VALUES (?, ?)',
      args: [slug, deviceId]
    });

    // Add to subscriptions
    if (!subscriptions.has(deviceId)) {
      subscriptions.set(deviceId, new Set());
    }
    subscriptions.get(deviceId).add(slug);

    console.log(`✅ Webhook created: ${slug} -> ${deviceId}`);
    return { success: true };
  } catch (err) {
    console.error('Error registering webhook:', err);
    return { success: false, error: err.message };
  }
}

// Delete a webhook
async function deleteWebhook(slug, deviceId) {
  try {
    const result = await db.execute({
      sql: 'DELETE FROM webhooks WHERE slug = ? AND device_id = ?',
      args: [slug, deviceId]
    });

    if (subscriptions.has(deviceId)) {
      subscriptions.get(deviceId).delete(slug);
    }

    return { success: result.rowsAffected > 0 };
  } catch (err) {
    console.error('Error deleting webhook:', err);
    return { success: false, error: err.message };
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

    // Save notification to DB first
    await db.execute({
      sql: `INSERT INTO notifications 
            (webhook_slug, title, subtitle, message, icon, priority, sound, image, on_click_link)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        slug,
        data.title || null,
        data.subtitle || null,
        data.message || 'New notification',
        data.icon || null,
        data.priority || 3,
        data.sound || null,
        data.image || null,
        data.onClickLink || null
      ]
    });

    // Update last_used
    await db.execute({
      sql: 'UPDATE webhooks SET last_used = CURRENT_TIMESTAMP WHERE slug = ?',
      args: [slug]
    });

    // Send to device if connected
    const ws = connections.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'notification',
        slug: slug,
        title: data.title || null,
        subtitle: data.subtitle || null,
        message: data.message || 'New notification',
        icon: data.icon || null,
        priority: data.priority || 3,
        sound: data.sound || 'default',
        image: data.image || null,
        onClickLink: data.onClickLink || null,
        timestamp: new Date().toISOString()
      }));
      console.log(`📤 Notification sent to device ${deviceId} for slug ${slug}`);
    } else {
      console.log(`📱 Device ${deviceId} offline, notification saved for later`);
    }

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
    totalWebhooks: subscriptions.size,
    docs: {
      create: 'POST /w/your-slug with JSON body',
      example: '{ "title": "Sale!", "message": "💰 $299", "priority": 5 }'
    }
  });
});

// Main webhook endpoint - POST /w/your-custom-slug
app.post('/w/:slug', async (req, res) => {
  const { slug } = req.params;
  const data = {
    title: req.body.title,
    subtitle: req.body.subtitle,
    message: req.body.message || '💰 New notification!',
    icon: req.body.icon,
    priority: req.body.priority || 3,
    sound: req.body.sound || 'default',
    image: req.body.image,
    onClickLink: req.body.onClickLink || req.body.on_click_link
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

// GET version for quick testing
app.get('/w/:slug', async (req, res) => {
  const { slug } = req.params;
  const message = req.query.message || req.query.m || '💰 Test notification!';
  const title = req.query.title || req.query.t;

  const result = await sendNotification(slug, { 
    title,
    message,
    priority: 5 
  });

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

// Get webhook info and recent notifications
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

    const notifications = await getNotifications(slug, 20);

    res.json({
      webhook: webhook.rows[0],
      notifications: notifications
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    connections: connections.size,
    webhooks: Array.from(subscriptions.values()).reduce((sum, set) => sum + set.size, 0)
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Sales Bell server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws/device_id`);
  console.log(`🔗 Webhook format: POST http://localhost:${PORT}/w/your-slug`);
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
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

// Cloudflare Worker URL for push notifications
const WEBHOOK_URL = process.env.WEBHOOK_URL;

app.use(cors());
app.use(express.json());
app.use(express.text());

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Initialize database
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      title TEXT,
      priority INTEGER DEFAULT 3,
      time INTEGER NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_topic_time ON messages(topic, time DESC)`);
  console.log('✅ Database ready');
}

initDB().catch(console.error);

// Topic subscribers: Map<topic, Set<WebSocket>>
const subscribers = new Map();

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, topic) => {
  console.log(`📱 Client connected to: ${topic}`);
  
  if (!subscribers.has(topic)) {
    subscribers.set(topic, new Set());
  }
  subscribers.get(topic).add(ws);
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Send open message
  ws.send(JSON.stringify({ event: 'open', topic }));

  ws.on('close', () => {
    const subs = subscribers.get(topic);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) subscribers.delete(topic);
    }
    console.log(`❌ Client disconnected from: ${topic}`);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Generate ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// Send webhook to Cloudflare Worker for push notifications
async function sendWebhook(topic, message) {
  if (!WEBHOOK_URL) {
    console.log('⚠️  Webhook URL not configured - skipping push notification');
    return;
  }

  try {
    const response = await fetch(`${WEBHOOK_URL}/webhook/${topic}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: message.id,
        topic: message.topic,
        title: message.title,
        message: message.message,
        priority: message.priority,
        time: message.time
      })
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`📲 Push notifications sent: ${result.sent || 0} devices`);
    } else {
      console.error('❌ Webhook failed:', response.statusText);
    }
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
}

// Publish message
async function publish(topic, data) {
  const id = genId();
  const time = Math.floor(Date.now() / 1000);
  
  const msg = {
    id,
    time,
    event: 'message',
    topic,
    message: data.message || 'New notification',
    title: data.title || null,
    priority: data.priority || 3
  };

  // Save to DB
  try {
    await db.execute({
      sql: 'INSERT INTO messages (id, topic, message, title, priority, time) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, topic, msg.message, msg.title, msg.priority, time]
    });
    console.log(`💾 Saved: ${topic} - Title: "${msg.title || 'none'}" - Message: "${msg.message}"`);
  } catch (err) {
    console.error('DB error:', err);
  }

  // Count WebSocket subscribers
  const subs = subscribers.get(topic);
  let webSocketCount = 0;
  if (subs && subs.size > 0) {
    const payload = JSON.stringify(msg);
    subs.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        webSocketCount++;
      }
    });
    console.log(`📤 Sent to ${webSocketCount} WebSocket subscribers (instant mode)`);
  }

  // Send webhook for push notifications ONLY if no WebSocket subscribers
  // This prevents duplicate notifications
  if (webSocketCount === 0) {
    sendWebhook(topic, msg).catch(err => {
      console.error('Webhook error:', err);
    });
  } else {
    console.log('ℹ️  Skipping push notification (users connected via WebSocket)');
  }

  return { id, message: msg };
}

// Routes
app.get('/', (req, res) => {
  res.json({
    app: 'Sales Bell',
    version: '2.0.0',
    features: ['WebSocket', 'Push Notifications'],
    topics: subscribers.size,
    subscribers: Array.from(subscribers.values()).reduce((sum, set) => sum + set.size, 0),
    webhook_configured: !!WEBHOOK_URL
  });
});

// Publish to topic
app.post('/:topic', async (req, res) => {
  const { topic } = req.params;
  
  let data;
  
  const contentType = req.headers['content-type'] || '';
  
  if (contentType.includes('application/json')) {
    data = {
      message: req.body.message || 'New notification',
      title: req.body.title || null,
      priority: parseInt(req.body.priority || 3)
    };
  } else if (typeof req.body === 'string') {
    data = { 
      message: req.body,
      title: null,
      priority: 3
    };
  } else {
    data = {
      message: req.query.message || 'New notification',
      title: req.query.title || null,
      priority: parseInt(req.query.priority || 3)
    };
  }

  console.log(`📨 Received: Topic="${topic}", Title="${data.title}", Message="${data.message}"`);

  const result = await publish(topic, data);
  res.json({ 
    success: true, 
    id: result.id,
    message: result.message 
  });
});

// Get messages
app.get('/:topic/json', async (req, res) => {
  const { topic } = req.params;
  const since = req.query.since || '24h';
  
  let sinceTime = 0;
  const now = Math.floor(Date.now() / 1000);
  
  if (since === 'all') {
    sinceTime = 0;
  } else if (since.match(/^\d+[smhd]$/)) {
    const val = parseInt(since);
    const unit = since.slice(-1);
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
    sinceTime = now - (val * mult);
  } else if (since.match(/^\d+$/)) {
    sinceTime = parseInt(since);
  }

  try {
    const result = await db.execute({
      sql: 'SELECT id, topic, message, title, priority, time FROM messages WHERE topic = ? AND time > ? ORDER BY time ASC LIMIT 1000',
      args: [topic, sinceTime]
    });

    const messages = result.rows.map(row => ({
      id: row.id,
      time: row.time,
      event: 'message',
      topic: row.topic,
      message: row.message,
      title: row.title,
      priority: row.priority
    }));

    res.json(messages);
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete all messages for a topic
app.delete('/:topic/messages', async (req, res) => {
  const { topic } = req.params;
  
  try {
    const result = await db.execute({
      sql: 'DELETE FROM messages WHERE topic = ?',
      args: [topic]
    });
    
    console.log(`🗑️  Deleted all messages for: ${topic}`);
    res.json({ success: true, deleted: result.rowsAffected || 0 });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/v1/health', (req, res) => {
  res.json({ healthy: true });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready on ws://localhost:${PORT}`);
  console.log(`📲 Push notifications: ${WEBHOOK_URL ? '✅ Enabled' : '❌ Not configured'}`);
  console.log(`\n📝 Usage:`);
  console.log(`   curl -X POST http://localhost:${PORT}/your-topic -H "Content-Type: application/json" -d '{"title":"Hello","message":"World"}'`);
  console.log(`   curl -X POST http://localhost:${PORT}/your-topic -d "Plain text message"\n`);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/([^\/]+)\/ws$/);
  
  if (match) {
    const topic = match[1];
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, topic);
    });
  } else {
    socket.destroy();
  }
});

process.on('SIGTERM', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
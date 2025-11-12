// server.js - Simplified ntfy-like server (Push notifications only)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // Cloudflare Worker URL

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
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_topic_time 
    ON messages(topic, time DESC)
  `);
  console.log('✅ Database ready');
}

initDB().catch(console.error);

// Generate unique ID
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// Send webhook to Cloudflare Worker for push notifications
async function sendPushNotification(topic, message) {
  if (!WEBHOOK_URL) {
    console.log('⚠️  WEBHOOK_URL not configured - skipping push');
    return;
  }

  try {
    const response = await fetch(`${WEBHOOK_URL}/webhook/${topic}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      console.log(`📲 Push sent to ${result.sent || 0} devices`);
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
    topic,
    message: data.message || 'New notification',
    title: data.title || null,
    priority: data.priority || 3
  };

  // Save to database
  try {
    await db.execute({
      sql: `INSERT INTO messages (id, topic, message, title, priority, time) 
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, topic, msg.message, msg.title, msg.priority, time]
    });
    console.log(`💾 Saved: ${topic} - "${msg.title || 'No title'}" - "${msg.message}"`);
  } catch (err) {
    console.error('❌ DB error:', err);
  }

  // Send push notification via Cloudflare Worker
  await sendPushNotification(topic, msg);

  return { id, message: msg };
}

// Routes
app.get('/', (req, res) => {
  res.json({
    app: 'Sales Bell',
    version: '2.0.0',
    mode: 'push-only',
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

  console.log(`📨 Received: "${topic}" - "${data.title}" - "${data.message}"`);

  const result = await publish(topic, data);
  
  res.json({ 
    success: true, 
    id: result.id,
    message: result.message 
  });
});

// Get messages for a topic
app.get('/:topic/json', async (req, res) => {
  const { topic } = req.params;
  const since = req.query.since || '24h';
  
  let sinceTime = 0;
  const now = Math.floor(Date.now() / 1000);
  
  // Parse "since" parameter
  if (since === 'all') {
    sinceTime = 0;
  } else if (since.match(/^\d+[smhd]$/)) {
    const val = parseInt(since);
    const unit = since.slice(-1);
    const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
    sinceTime = now - (val * multipliers[unit]);
  } else if (since.match(/^\d+$/)) {
    sinceTime = parseInt(since);
  }

  try {
    const result = await db.execute({
      sql: `SELECT id, topic, message, title, priority, time 
            FROM messages 
            WHERE topic = ? AND time > ? 
            ORDER BY time ASC 
            LIMIT 1000`,
      args: [topic, sinceTime]
    });

    const messages = result.rows.map(row => ({
      id: row.id,
      time: row.time,
      topic: row.topic,
      message: row.message,
      title: row.title,
      priority: row.priority
    }));

    res.json(messages);
  } catch (err) {
    console.error('❌ Query error:', err);
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
    res.json({ 
      success: true, 
      deleted: result.rowsAffected || 0 
    });
  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/v1/health', (req, res) => {
  res.json({ healthy: true });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Sales Bell Server`);
  console.log(`   Mode: Push Notifications Only`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Push: ${WEBHOOK_URL ? '✅ Enabled' : '❌ Not configured'}`);
  console.log(`\n📝 Usage:`);
  console.log(`   POST http://localhost:${PORT}/your-topic`);
  console.log(`   Body: {"title":"Sale!","message":"$299 Order #1234","priority":5}`);
  console.log();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
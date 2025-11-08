const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const connections = new Map();
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, request, deviceId) => {
  connections.set(deviceId, ws);
  console.log(`✅ Device connected: ${deviceId}`);
  
  ws.on('close', () => {
    connections.delete(deviceId);
    console.log(`❌ Device disconnected: ${deviceId}`);
  });
});

app.post('/notify/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const message = req.body.message || req.query.message || 'New notification!';
  
  const ws = connections.get(deviceId);
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'notification',
      message,
      timestamp: new Date().toISOString()
    }));
    res.json({ success: true, message: 'Notification sent' });
  } else {
    res.status(404).json({ success: false, message: 'Device not connected' });
  }
});

app.get('/notify/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const message = req.query.message || '💰 Test notification!';
  
  const ws = connections.get(deviceId);
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'notification', message, timestamp: new Date().toISOString() }));
    res.send(`✅ Notification sent: "${message}"`);
  } else {
    res.status(404).send(`❌ Device not connected`);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', connections: connections.size });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const match = pathname.match(/^\/ws\/(.+)$/);
  
  if (match) {
    const deviceId = match[1];
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, deviceId);
    });
  } else {
    socket.destroy();
  }
});

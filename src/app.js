import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();
import { initializeDatabase } from './config/db.js';
import callRoutes from './routes/callRoutes.js';
import http from 'http';
import { initializeWebSocket } from './services/websocketService.js';

import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

const MOCK_IVR_URL = process.env.MOCK_IVR_URL || 'http://localhost:5001';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Proxy /api/mock-ivr/* → Mock IVR server (port 5001)
// This allows a single ngrok tunnel on port 5000 to serve both backend + mock IVR
app.use('/api/mock-ivr', createProxyMiddleware({
  target: MOCK_IVR_URL,
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq, req) => {
      console.log(`[Proxy] ${req.method} ${req.path} → ${MOCK_IVR_URL}${req.path}`);
    }
  }
}));

// Routing
app.use('/api/call', callRoutes);

// Healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Twilio IVR Platform Backend is running.' });
});

// Root fallback
app.get('/', (req, res) => {
  res.status(200).send('Twilio IVR Platform Backend is running. Visit /health for status.');
});

// Run Server & Db Sync
const startServer = async () => {
  await initializeDatabase();
  initializeWebSocket(server);
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

startServer();

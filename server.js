import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.WEB_PORT || 3000;
const DATA_DIR = './data';
const CONFIG_FILE = `${DATA_DIR}/config.json`;
const USERS_FILE = `${DATA_DIR}/users.json`;
const PUNCH_HISTORY_FILE = `${DATA_DIR}/punch_history.json`;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default config
const DEFAULT_CONFIG = {
  enabled: true,
  skipDates: [],
  morningStart: process.env.MORNING_START || '08:00',
  morningEnd: process.env.MORNING_END || '08:30',
  eveningStart: process.env.EVENING_START || '17:50',
  eveningEnd: process.env.EVENING_END || '18:00',
};

// Load or create config
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  return { ...DEFAULT_CONFIG };
}

// Save config
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Load or create users
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

// Save users
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Load punch history
function loadPunchHistory() {
  if (fs.existsSync(PUNCH_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PUNCH_HISTORY_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

// Initialize default admin user if no users exist
function initializeDefaultUser() {
  const users = loadUsers();
  if (users.length === 0) {
    const defaultPassword = process.env.DASHBOARD_PASSWORD || 'admin123';
    const defaultUsername = process.env.DASHBOARD_USERNAME || 'admin';
    const hashedPassword = bcrypt.hashSync(defaultPassword, 10);
    users.push({
      id: 1,
      username: defaultUsername,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
    });
    saveUsers(users);
    console.log(`[Dashboard] Default user created: ${defaultUsername}`);
  }
}

// Initialize
initializeDefaultUser();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'attendance-bot-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// API Routes

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.username === username);
  
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Check auth status
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ authenticated: true, username: req.session.username });
  } else {
    res.json({ authenticated: false });
  }
});

// Get config
app.get('/api/config', requireAuth, (req, res) => {
  const config = loadConfig();
  res.json(config);
});

// Update config
app.put('/api/config', requireAuth, (req, res) => {
  const currentConfig = loadConfig();
  const newConfig = { ...currentConfig, ...req.body };
  saveConfig(newConfig);
  res.json(newConfig);
});

// Toggle bot enabled/disabled
app.post('/api/config/toggle', requireAuth, (req, res) => {
  const config = loadConfig();
  config.enabled = !config.enabled;
  saveConfig(config);
  res.json({ enabled: config.enabled });
});

// Get skip dates
app.get('/api/skip-dates', requireAuth, (req, res) => {
  const config = loadConfig();
  res.json({ skipDates: config.skipDates || [] });
});

// Add skip date
app.post('/api/skip-dates', requireAuth, (req, res) => {
  const { date, reason } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }
  
  const config = loadConfig();
  if (!config.skipDates) {
    config.skipDates = [];
  }
  
  // Check if date already exists
  const exists = config.skipDates.some(d => d.date === date);
  if (exists) {
    return res.status(400).json({ error: 'Date already exists' });
  }
  
  config.skipDates.push({ date, reason: reason || '', addedAt: new Date().toISOString() });
  config.skipDates.sort((a, b) => a.date.localeCompare(b.date));
  saveConfig(config);
  res.json({ skipDates: config.skipDates });
});

// Remove skip date
app.delete('/api/skip-dates/:date', requireAuth, (req, res) => {
  const { date } = req.params;
  const config = loadConfig();
  config.skipDates = (config.skipDates || []).filter(d => d.date !== date);
  saveConfig(config);
  res.json({ skipDates: config.skipDates });
});

// Get punch history
app.get('/api/punch-history', requireAuth, (req, res) => {
  const history = loadPunchHistory();
  // Return last 30 entries, newest first
  res.json({ history: history.slice(-30).reverse() });
});

// Trigger manual punch
const TRIGGER_FILE = `${DATA_DIR}/trigger_punch.json`;
const RESULT_FILE = `${DATA_DIR}/trigger_result.json`;

app.post('/api/trigger-punch', requireAuth, async (req, res) => {
  const { type } = req.body; // 'Morning', 'Evening', or 'auto'
  
  // Check if a trigger is already pending
  if (fs.existsSync(TRIGGER_FILE)) {
    return res.status(400).json({ error: 'A punch is already in progress' });
  }
  
  // Clear any old result file
  if (fs.existsSync(RESULT_FILE)) {
    fs.unlinkSync(RESULT_FILE);
  }
  
  // Write trigger file
  const triggeredAt = new Date().toISOString();
  fs.writeFileSync(TRIGGER_FILE, JSON.stringify({
    type: type || 'auto',
    triggeredAt,
  }));
  
  // Wait for result (max 60 seconds)
  const startTime = Date.now();
  const timeout = 60000;
  
  const checkResult = () => {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (fs.existsSync(RESULT_FILE)) {
          clearInterval(interval);
          try {
            const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf-8'));
            fs.unlinkSync(RESULT_FILE);
            resolve(result);
          } catch {
            resolve({ success: false, error: 'Failed to read result' });
          }
        } else if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          // Clean up trigger file if still exists
          if (fs.existsSync(TRIGGER_FILE)) {
            fs.unlinkSync(TRIGGER_FILE);
          }
          resolve({ success: false, error: 'Timeout waiting for punch result' });
        }
      }, 1000);
    });
  };
  
  const result = await checkResult();
  
  if (result.success) {
    res.json({ success: true, message: 'Punch completed successfully' });
  } else {
    res.status(500).json({ success: false, error: result.error || 'Punch failed' });
  }
});

// Get future pending punches
app.get('/api/pending-punches', requireAuth, (req, res) => {
  const config = loadConfig();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const currentTime = now.getHours() * 60 + now.getMinutes();
  
  const pendingPunches = [];
  
  // Check if bot is enabled
  if (!config.enabled) {
    return res.json({ pending: [], message: 'Bot is disabled' });
  }
  
  // Calculate pending punches for the next 7 days
  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);
    const dayOfWeek = date.getDay();
    
    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    
    // Skip dates in skip list
    const isSkipped = (config.skipDates || []).some(d => d.date === dateStr);
    if (isSkipped) continue;
    
    const morningStart = parseTimeToMinutes(config.morningStart || '08:00');
    const eveningStart = parseTimeToMinutes(config.eveningStart || '17:50');
    
    // For today, only add if time hasn't passed
    if (dateStr === today) {
      if (currentTime < morningStart + 30) {
        pendingPunches.push({
          date: dateStr,
          type: 'Morning',
          window: `${config.morningStart} - ${config.morningEnd}`,
        });
      }
      if (currentTime < eveningStart + 10) {
        pendingPunches.push({
          date: dateStr,
          type: 'Evening',
          window: `${config.eveningStart} - ${config.eveningEnd}`,
        });
      }
    } else {
      pendingPunches.push({
        date: dateStr,
        type: 'Morning',
        window: `${config.morningStart} - ${config.morningEnd}`,
      });
      pendingPunches.push({
        date: dateStr,
        type: 'Evening',
        window: `${config.eveningStart} - ${config.eveningEnd}`,
      });
    }
  }
  
  res.json({ pending: pendingPunches });
});

// Update schedule
app.put('/api/schedule', requireAuth, (req, res) => {
  const { morningStart, morningEnd, eveningStart, eveningEnd } = req.body;
  const config = loadConfig();
  
  if (morningStart) config.morningStart = morningStart;
  if (morningEnd) config.morningEnd = morningEnd;
  if (eveningStart) config.eveningStart = eveningStart;
  if (eveningEnd) config.eveningEnd = eveningEnd;
  
  saveConfig(config);
  res.json(config);
});

// Change password
app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  
  user.password = bcrypt.hashSync(newPassword, 10);
  saveUsers(users);
  res.json({ success: true });
});

// Helper function
function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dashboard] Web UI running at http://localhost:${PORT}`);
});

export { loadConfig, loadPunchHistory, saveConfig };

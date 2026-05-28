import { chromium } from 'playwright';
import dotenv from 'dotenv';
import cron from 'node-cron';
import fs from 'fs';

dotenv.config();

const LOGIN_URL = 'https://app.hrone.cloud/login';
const API_BASE = 'https://app.hrone.cloud/api';
const DATA_DIR = './data';
const COOKIES_FILE = `${DATA_DIR}/cookies.json`;
const AUTH_FILE = `${DATA_DIR}/auth.json`;
const CONFIG_FILE = `${DATA_DIR}/config.json`;
const PUNCH_HISTORY_FILE = `${DATA_DIR}/punch_history.json`;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;
const DOMAIN_CODE = process.env.DOMAIN_CODE;

// Optional: Google Chat webhook for notifications
const GOOGLE_CHAT_WEBHOOK_URL = process.env.GOOGLE_CHAT_WEBHOOK_URL;

if (!USERNAME || !PASSWORD || !DOMAIN_CODE) {
  console.error('❌ Missing USERNAME, PASSWORD, or DOMAIN_CODE in .env file');
  process.exit(1);
}

// Load config from file (shared with web dashboard)
function loadConfig() {
  const defaultConfig = {
    enabled: true,
    skipDates: [],
    morningStart: process.env.MORNING_START || '08:00',
    morningEnd: process.env.MORNING_END || '08:30',
    eveningStart: process.env.EVENING_START || '17:50',
    eveningEnd: process.env.EVENING_END || '18:00',
  };
  
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...defaultConfig, ...config };
    } catch {
      return defaultConfig;
    }
  }
  return defaultConfig;
}

// Save punch history
function savePunchHistory(entry) {
  let history = [];
  if (fs.existsSync(PUNCH_HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(PUNCH_HISTORY_FILE, 'utf-8'));
    } catch {
      history = [];
    }
  }
  
  history.push(entry);
  
  // Keep only last 100 entries
  if (history.length > 100) {
    history = history.slice(-100);
  }
  
  fs.writeFileSync(PUNCH_HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Check if today should be skipped
function shouldSkipToday(config) {
  const today = new Date().toISOString().slice(0, 10);
  return (config.skipDates || []).some(d => d.date === today);
}

// Parse time string "HH:MM" to { hour, minute }
function parseTime(timeStr) {
  const [hour, minute] = timeStr.split(':').map(Number);
  return { hour, minute };
}

// Calculate random delay between two times
function getRandomDelayBetweenTimes(startTime, endTime) {
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  const diffMinutes = endMinutes - startMinutes;
  
  return Math.floor(Math.random() * diffMinutes);
}

// Log with timestamp
function log(msg) {
  console.log(`[${new Date().toLocaleString()}] ${msg}`);
}

// Send notification to Google Chat (optional - fails silently if not configured)
async function sendGoogleChatNotification(message) {
  if (!GOOGLE_CHAT_WEBHOOK_URL) {
    return; // Skip if not configured
  }
  
  try {
    const response = await fetch(GOOGLE_CHAT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    
    if (response.ok) {
      log('💬 Google Chat notification sent');
    } else {
      log(`⚠️ Google Chat notification failed: ${response.status}`);
    }
  } catch (err) {
    // Fail silently - don't let notification errors affect main functionality
    log(`⚠️ Google Chat notification error: ${err.message}`);
  }
}

// Save auth data (cookies + employee info)
function saveAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  log('💾 Auth data saved');
}

// Load auth data
function loadAuth() {
  if (fs.existsSync(AUTH_FILE)) {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  }
  return null;
}

// Login using Playwright and capture auth tokens
async function loginAndGetAuth() {
  log('🔐 Logging in via browser...');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  let employeeId = null;
  
  // Capture the employee ID from API response
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('/api/LogOnUser/LogOnUserDetail')) {
      try {
        const data = await response.json();
        employeeId = data.employeeId;
        log(`👤 Employee ID: ${employeeId}`);
      } catch {}
    }
  });
  
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  
  await page.getByLabel('MOBILE NO/ EMAIL').fill(USERNAME);
  await page.getByRole('button', { name: 'NEXT' }).click();
  await page.waitForTimeout(2000);
  
  await page.getByLabel('PASSWORD').fill(PASSWORD);
  await page.getByRole('button', { name: 'LOG IN' }).click();
  await page.waitForTimeout(5000);
  
  // Get cookies
  const cookies = await context.cookies();
  const jwtCookie = cookies.find(c => c.name === 'JwtTokenCookie');
  const refreshCookie = cookies.find(c => c.name === 'RefreshTokenCookie');
  
  await browser.close();
  
  if (!jwtCookie) {
    throw new Error('Failed to get JWT token');
  }
  
  const authData = {
    jwt: jwtCookie.value,
    refresh: refreshCookie?.value,
    employeeId: employeeId,
    cookies: cookies,
    updatedAt: new Date().toISOString(),
  };
  
  saveAuth(authData);
  log('✅ Login successful');
  
  return authData;
}

// Make authenticated API request
async function apiRequest(endpoint, method = 'GET', body = null, auth) {
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'domaincode': DOMAIN_CODE,
    'accessmode': 'W',
    'x-requested-with': 'https://app.hrone.cloud',
    'Cookie': `JwtTokenCookie=${auth.jwt}; RefreshTokenCookie=${auth.refresh}`,
  };
  
  const options = {
    method,
    headers,
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(`${API_BASE}${endpoint}`, options);
  
  if (response.status === 401) {
    throw new Error('AUTH_EXPIRED');
  }
  
  return response;
}

// Mark attendance via API
async function markAttendanceAPI(auth, punchType = 'auto') {
  const now = new Date();
  // Format as local time: YYYY-MM-DDTHH:mm
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const punchTime = `${year}-${month}-${day}T${hours}:${minutes}`;
  
  log(`📍 Marking attendance at ${punchTime}...`);
  
  const payload = {
    requestType: 'A',
    applyRequestSource: 10,
    employeeId: auth.employeeId,
    latitude: '',
    longitude: '',
    geoAccuracy: '',
    geoLocation: '',
    punchTime: punchTime,
    remarks: '',
    uploadedPhotoOneName: '',
    uploadedPhotoOnePath: '',
    uploadedPhotoTwoName: '',
    uploadedPhotoTwoPath: '',
    attendanceSource: 'W',
    attendanceType: 'Online',
  };
  
  const response = await apiRequest(
    '/timeoffice/mobile/checkin/Attendance/Request',
    'POST',
    payload,
    auth
  );
  
  const result = await response.json();
  
  // Determine punch type for history
  const hour = now.getHours();
  const type = punchType === 'auto' ? (hour < 12 ? 'Morning' : 'Evening') : punchType;
  
  // Save to punch history
  const historyEntry = {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}`,
    type: type,
    success: result.message === 'Record saved successfully.',
    message: result.message,
    punchTime: punchTime,
    recordedAt: now.toISOString(),
  };
  savePunchHistory(historyEntry);
  
  if (result.message === 'Record saved successfully.') {
    log('✅ Attendance marked successfully!');
    
    // Send Google Chat notification (optional)
    const punchTypeLabel = hour < 12 ? '🌅 Morning Punch-In' : '🌆 Evening Punch-Out';
    const displayName = (process.env.DASHBOARD_USERNAME || USERNAME.split('@')[0] || 'User')
      .replace(/^\w/, c => c.toUpperCase());
    await sendGoogleChatNotification(
      `${punchTypeLabel}\n👤 ${displayName}\n✅ Attendance marked at ${punchTime.replace('T', ' ')}`
    );
    
    return true;
  } else {
    log(`⚠️ Attendance response: ${JSON.stringify(result)}`);
    return false;
  }
}

// Check current attendance status
async function checkAttendanceStatus(auth) {
  const today = new Date().toISOString().slice(0, 10);
  
  try {
    const response = await apiRequest(
      `/timeoffice/mobile/checkin/Setting?employeeId=${auth.employeeId}&deviceName=web&deviceVersion=web%20+%20&requestSource=10`,
      'GET',
      null,
      auth
    );
    
    const data = await response.json();
    log(`📊 Last punch: ${data.lastLogOnPunch} (${data.punchSource})`);
    return data;
  } catch (err) {
    log(`⚠️ Could not check status: ${err.message}`);
    return null;
  }
}

// Main function
async function runAttendanceBot(punchType = 'auto') {
  log('');
  log('🤖 HROne Attendance Bot');
  log('='.repeat(50));
  
  // Check config first
  const config = loadConfig();
  
  // Check if bot is disabled
  if (!config.enabled) {
    log('⏸️ Bot is disabled via dashboard. Skipping...');
    return;
  }
  
  // Check if today is a skip date
  if (shouldSkipToday(config)) {
    const today = new Date().toISOString().slice(0, 10);
    const skipInfo = config.skipDates.find(d => d.date === today);
    log(`⏭️ Skipping today (${today}): ${skipInfo?.reason || 'Marked as skip date'}`);
    return;
  }
  
  try {
    // Try to load existing auth
    let auth = loadAuth();
    
    // Check if auth is valid (less than 12 hours old)
    if (auth) {
      const authAge = Date.now() - new Date(auth.updatedAt).getTime();
      const maxAge = 12 * 60 * 60 * 1000; // 12 hours
      
      if (authAge > maxAge) {
        log('⏰ Auth expired, refreshing...');
        auth = null;
      }
    }
    
    // Login if needed
    if (!auth || !auth.jwt || !auth.employeeId) {
      auth = await loginAndGetAuth();
    } else {
      log('🍪 Using cached auth');
    }
    
    // Check current status
    await checkAttendanceStatus(auth);
    
    // Mark attendance
    const success = await markAttendanceAPI(auth, punchType);
    
    if (!success) {
      // Maybe auth expired, try refreshing
      log('🔄 Retrying with fresh login...');
      auth = await loginAndGetAuth();
      await markAttendanceAPI(auth, punchType);
    }
    
  } catch (error) {
    if (error.message === 'AUTH_EXPIRED') {
      log('🔄 Auth expired, logging in again...');
      const auth = await loginAndGetAuth();
      await markAttendanceAPI(auth, punchType);
    } else {
      log(`❌ Error: ${error.message}`);
      
      // Save failed attempt to history
      const now = new Date();
      savePunchHistory({
        date: now.toISOString().slice(0, 10),
        time: now.toTimeString().slice(0, 5),
        type: punchType === 'auto' ? (now.getHours() < 12 ? 'Morning' : 'Evening') : punchType,
        success: false,
        message: error.message,
        recordedAt: now.toISOString(),
      });
    }
  }
}

// Schedule jobs based on config
function scheduleJobs() {
  const config = loadConfig();
  
  const morningStart = parseTime(config.morningStart);
  const eveningStart = parseTime(config.eveningStart);
  
  log('🚀 Starting HROne Attendance Bot');
  log('📅 Schedule (Mon-Fri):');
  log(`   • Morning: ${config.morningStart} - ${config.morningEnd}`);
  log(`   • Evening: ${config.eveningStart} - ${config.eveningEnd}`);
  log(`💬 Google Chat: ${GOOGLE_CHAT_WEBHOOK_URL ? 'Enabled' : 'Disabled'}`);
  log('Press Ctrl+C to stop\n');
  
  // Schedule for morning (at MORNING_START time, then add random delay)
  const morningCron = `${morningStart.minute} ${morningStart.hour} * * 1-5`;
  cron.schedule(morningCron, () => {
    const currentConfig = loadConfig(); // Reload config
    const delayMinutes = getRandomDelayBetweenTimes(currentConfig.morningStart, currentConfig.morningEnd);
    log(`📅 Morning punch scheduled: ${currentConfig.morningStart} + ${delayMinutes} min delay`);
    
    setTimeout(() => {
      log(`\n⏰ Morning punch-in`);
      runAttendanceBot('Morning');
    }, delayMinutes * 60 * 1000);
  });
  
  // Schedule for evening (at EVENING_START time, then add random delay)
  const eveningCron = `${eveningStart.minute} ${eveningStart.hour} * * 1-5`;
  cron.schedule(eveningCron, () => {
    const currentConfig = loadConfig(); // Reload config
    const delayMinutes = getRandomDelayBetweenTimes(currentConfig.eveningStart, currentConfig.eveningEnd);
    log(`📅 Evening punch scheduled: ${currentConfig.eveningStart} + ${delayMinutes} min delay`);
    
    setTimeout(() => {
      log(`\n⏰ Evening punch-out`);
      runAttendanceBot('Evening');
    }, delayMinutes * 60 * 1000);
  });
  
  log('💤 Bot is running... waiting for scheduled times');
  log(`📍 Current time: ${new Date().toLocaleString()}`);
  
  // Keep process alive and log heartbeat every hour
  setInterval(() => {
    log('💓 Heartbeat - bot still running');
  }, 60 * 60 * 1000);
}

// Watch for manual trigger file
const TRIGGER_FILE = `${DATA_DIR}/trigger_punch.json`;

function watchTriggerFile() {
  setInterval(async () => {
    if (fs.existsSync(TRIGGER_FILE)) {
      try {
        const trigger = JSON.parse(fs.readFileSync(TRIGGER_FILE, 'utf-8'));
        fs.unlinkSync(TRIGGER_FILE); // Delete trigger file immediately
        
        log(`\n🔔 Manual punch triggered: ${trigger.type || 'auto'}`);
        await runAttendanceBot(trigger.type || 'auto');
        
        // Write result file
        const resultFile = `${DATA_DIR}/trigger_result.json`;
        fs.writeFileSync(resultFile, JSON.stringify({
          success: true,
          triggeredAt: trigger.triggeredAt,
          completedAt: new Date().toISOString(),
        }));
      } catch (err) {
        log(`❌ Trigger error: ${err.message}`);
        const resultFile = `${DATA_DIR}/trigger_result.json`;
        fs.writeFileSync(resultFile, JSON.stringify({
          success: false,
          error: err.message,
          completedAt: new Date().toISOString(),
        }));
      }
    }
  }, 2000); // Check every 2 seconds
}

// Check if running in test mode
const isTestMode = process.argv.includes('--test');

if (isTestMode) {
  log('🧪 Running in TEST mode (single run)');
  runAttendanceBot().then(() => {
    log('✅ Test completed');
    process.exit(0);
  });
} else {
  scheduleJobs();
  watchTriggerFile();
}

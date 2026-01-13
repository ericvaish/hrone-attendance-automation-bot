# HROne Attendance Bot

Automated attendance marking bot for HROne. Runs twice daily at randomized times to punch in and out.

## How It Works

### Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      FIRST RUN / AUTH EXPIRED                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Launch headless Chromium browser (no GUI needed)            │
│                        ↓                                        │
│  2. Navigate to https://app.hrone.cloud/login                   │
│                        ↓                                        │
│  3. Fill email/mobile → Click NEXT                              │
│                        ↓                                        │
│  4. Fill password → Click LOG IN                                │
│                        ↓                                        │
│  5. Capture from response:                                      │
│     • JwtTokenCookie (auth token)                               │
│     • RefreshTokenCookie                                        │
│     • Employee ID                                               │
│                        ↓                                        │
│  6. Save to auth.json (cached for 12 hours)                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      SUBSEQUENT RUNS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Load cached auth from auth.json                             │
│                        ↓                                        │
│  2. Make direct API call (no browser needed):                   │
│                                                                 │
│     POST /api/timeoffice/mobile/checkin/Attendance/Request      │
│     Headers:                                                    │
│       - Cookie: JwtTokenCookie=xxx; RefreshTokenCookie=xxx      │
│       - domaincode: <company_code>                              │
│     Body:                                                       │
│       - employeeId: <your_id>                                   │
│       - punchTime: "2026-01-13T09:05"                           │
│       - attendanceSource: "W" (web)                             │
│       - attendanceType: "Online"                                │
│                        ↓                                        │
│  3. Response: {"message": "Record saved successfully."}         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Schedule

| Punch    | Default Window | Configurable via |
|----------|----------------|------------------|
| Morning  | 8:00 - 8:30 AM | `MORNING_START`, `MORNING_END` |
| Evening  | 5:50 - 6:00 PM | `EVENING_START`, `EVENING_END` |

- Runs **Monday to Friday** only
- Picks a random time within each window (looks natural, not same time daily)
- Configure times in `.env` using 24-hour format (e.g., `08:00`, `17:50`)

## Setup

### Prerequisites

- Docker & Docker Compose (recommended)
- OR Node.js 20+ (for local run)

### 1. Clone/Copy the project

```bash
cd /path/to/attendance
```

### 2. Create `.env` file

```bash
# .env
USERNAME=your.email@company.com
PASSWORD=your_password_here

# Company domain code (required)
# Found in HROne API responses or URL patterns
# Usually your company's short name
DOMAIN_CODE=yourcompany

# Schedule times (24-hour format, optional - defaults shown)
# Morning punch will happen randomly between START and END
MORNING_START=08:00
MORNING_END=08:30

# Evening punch will happen randomly between START and END
EVENING_START=17:50
EVENING_END=18:00

# Optional: Google Chat notifications
# Leave empty to disable notifications
GOOGLE_CHAT_WEBHOOK_URL=
```


### 2a. (Optional) Setup Google Chat Notifications

Get notified in Google Chat when attendance is marked:

1. Open **Google Chat** (chat.google.com)
2. Go to your **Space** (or create one)
3. Click the **Space name** at the top → **Space settings**
4. Go to **Apps & integrations**
5. Click **Add webhooks** (or **Manage webhooks**)
6. Click **Create webhook** (or **Add another**)
7. Give it a name (e.g., "Attendance Bot")
8. **Copy the webhook URL** (looks like `https://chat.googleapis.com/v1/spaces/...`)
9. Paste it in your `.env` file as `GOOGLE_CHAT_WEBHOOK_URL`

**Example notification:**
```
🌅 Morning Punch-In
✅ Attendance marked at 2026-01-13 08:15
```

If the webhook URL is not set, the bot works normally without notifications.

### 3. Run with Docker (Recommended)

```bash
# Build and start in background
docker compose up -d --build

# View logs
docker compose logs -f

# Stop
docker compose down
```

### 4. Run locally (Alternative)

```bash
# Install dependencies
npm install
npx playwright install chromium

# Test single run
node index.js --test

# Run scheduler
node index.js
```

## Files

| File | Purpose |
|------|---------|
| `index.js` | Main bot script |
| `.env` | Credentials (create this yourself) |
| `auth.json` | Cached auth tokens (auto-generated, persists across restarts) |
| `Dockerfile` | Container definition |
| `docker-compose.yml` | Docker orchestration |

## Configuration

### Timezone

The bot uses `Asia/Kolkata` (IST) timezone. Change in:

- `docker-compose.yml`: `TZ=Asia/Kolkata`
- `Dockerfile`: `ENV TZ=Asia/Kolkata`

### Schedule Times

Configure via `.env` file (24-hour format):

```bash
# Morning punch window (randomly picks a time between these)
MORNING_START=08:00
MORNING_END=08:30

# Evening punch window (randomly picks a time between these)
EVENING_START=17:50
EVENING_END=18:00
```

The bot runs **Monday to Friday** only. It will pick a random time within each window to make punches look natural.

### Google Chat Notifications

To receive notifications when attendance is marked:

1. **Get webhook URL:**
   - Open Google Chat → Your Space
   - Space name → Space settings → Apps & integrations
   - Add webhooks → Create webhook
   - Copy the webhook URL

2. **Add to `.env`:**
   ```bash
   GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/XXXXX/messages?key=YYY&token=ZZZ
   ```

3. **Restart the bot:**
   ```bash
   docker compose down && docker compose up -d
   ```

Notifications are optional - the bot works fine without them.

### Auth Cache Duration

Default: 12 hours. Change `maxAge` in `index.js`:

```javascript
const maxAge = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
```

## API Reference

### Mark Attendance

```
POST https://app.hrone.cloud/api/timeoffice/mobile/checkin/Attendance/Request
```

**Headers:**
```
Cookie: JwtTokenCookie=<jwt>; RefreshTokenCookie=<refresh>
Content-Type: application/json
domaincode: <company_code>
accessmode: W
x-requested-with: https://app.hrone.cloud
```

**Body:**
```json
{
  "requestType": "A",
  "applyRequestSource": 10,
  "employeeId": 1234,
  "latitude": "",
  "longitude": "",
  "geoAccuracy": "",
  "geoLocation": "",
  "punchTime": "2026-01-13T09:05",
  "remarks": "",
  "uploadedPhotoOneName": "",
  "uploadedPhotoOnePath": "",
  "uploadedPhotoTwoName": "",
  "uploadedPhotoTwoPath": "",
  "attendanceSource": "W",
  "attendanceType": "Online"
}
```

**Response:**
```json
{"message": "Record saved successfully.", "validationType": "0", "messageCode": null}
```

### Check Attendance Status

```
GET https://app.hrone.cloud/api/timeoffice/mobile/checkin/Setting?employeeId=<id>&deviceName=web&deviceVersion=web&requestSource=10
```

## Troubleshooting

### "Auth expired" on every run

The JWT token may be expiring faster than 12 hours. Reduce `maxAge` to 6 hours:
```javascript
const maxAge = 6 * 60 * 60 * 1000;
```

### "Device time not same as expected work location"

Your server timezone doesn't match your work location. Ensure `TZ` environment variable is set correctly.

### Container keeps restarting

Check logs: `docker compose logs`

Common issues:
- Missing `.env` file
- Invalid credentials
- Network issues

### Browser fails to launch in Docker

The Dockerfile includes all required dependencies for headless Chromium. If issues persist, try rebuilding:
```bash
docker compose build --no-cache
```

## Security Notes

1. **Credentials**: Store only in `.env`, never commit to git
2. **Auth tokens**: `auth.json` contains sensitive tokens, excluded from git
3. **Headless mode**: No GUI/display required, safe for servers
4. **Network**: Only connects to `app.hrone.cloud` and `gateway.app.hrone.cloud`

## License

MIT - Use at your own risk. This is for personal automation only.

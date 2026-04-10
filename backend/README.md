# VocalID — Backend API

Node.js + Express + MongoDB + JWT voice-based attendance system.

---

## 📁 Project Folder Structure

```
vocalid/
├── backend/                   ← All backend code lives here
│   ├── server.js              ← Main Express app (routes, models, middleware)
│   ├── package.json
│   ├── .env                   ← Environment variables (never commit this)
│   ├── .env.example           ← Safe template for .env
│   ├── .gitignore
│   └── uploads/               ← Voice samples stored here (auto-created)
│
├── css/
│   └── style.css
├── js/
│   └── vocalid.js
├── index.html
├── voice.html
├── student-login.html
├── faculty-login.html
├── dashboard.html
├── class.html
└── reports.html
```

---

## 📦 Required npm Packages

| Package | Purpose |
|---|---|
| `express` | HTTP server & routing |
| `mongoose` | MongoDB ODM |
| `bcryptjs` | Password hashing |
| `jsonwebtoken` | JWT creation & verification |
| `multer` | Multipart file uploads (voice samples) |
| `cors` | Cross-Origin Resource Sharing |
| `dotenv` | Environment variable loader |
| `nodemon` *(dev)* | Auto-restart on file changes |

Install all at once:
```bash
cd backend
npm install
```

---

## ▶️ Running the Server

**Development (auto-restart):**
```bash
cd backend
npm run dev
```

**Production:**
```bash
cd backend
npm start
```

Server starts at: `http://localhost:5000`

---

## 🔌 API Reference & Example Requests

> Base URL: `http://localhost:5000/api`
> Protected routes (🔒) require `Authorization: Bearer <token>` header.

---

### 1. POST `/api/register` — Register a student

**Request:**
```http
POST http://localhost:5000/api/register
Content-Type: application/json

{
  "name": "Abinaya Velliyangiri",
  "studentId": "CS001",
  "email": "abinaya@college.edu",
  "password": "securePass123"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Student registered successfully.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "student": {
    "id": "664a1c3fbe4a2c001fcb1234",
    "name": "Abinaya Velliyangiri",
    "studentId": "CS001",
    "email": "abinaya@college.edu",
    "isVoiceRegistered": false,
    "createdAt": "2025-05-20T07:00:00.000Z"
  }
}
```

---

### 2. POST `/api/login` — Student login

**Request:**
```http
POST http://localhost:5000/api/login
Content-Type: application/json

{
  "studentId": "CS001",
  "password": "securePass123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "student": {
    "id": "664a1c3fbe4a2c001fcb1234",
    "name": "Abinaya Velliyangiri",
    "studentId": "CS001",
    "email": "abinaya@college.edu",
    "isVoiceRegistered": true,
    "voiceUploadedAt": "2025-05-20T08:00:00.000Z"
  }
}
```

---

### 3. POST `/api/upload-voice` 🔒 — Upload voice sample

Send as **multipart/form-data** with the audio file under field name `voiceSample`.

**Using curl:**
```bash
curl -X POST http://localhost:5000/api/upload-voice \
  -H "Authorization: Bearer <your_token>" \
  -F "voiceSample=@/path/to/voice.wav"
```

**Using JavaScript (fetch):**
```javascript
const formData = new FormData();
formData.append('voiceSample', audioBlob, 'voice.wav');

const response = await fetch('http://localhost:5000/api/upload-voice', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData
});
const data = await response.json();
```

**Response (200):**
```json
{
  "success": true,
  "message": "Voice sample uploaded successfully.",
  "voiceSample": {
    "filename": "voice-1716192000000-123456789.wav",
    "path": "uploads/voice-1716192000000-123456789.wav",
    "size": 245760,
    "mimetype": "audio/wav",
    "uploadedAt": "2025-05-20T08:00:00.000Z"
  }
}
```

---

### 4. POST `/api/mark-attendance` 🔒 — Mark attendance

**Request:**
```http
POST http://localhost:5000/api/mark-attendance
Authorization: Bearer <your_token>
Content-Type: application/json

{
  "subject": "Computer Networks",
  "confidence": 94.5,
  "method": "voice"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Attendance marked for Abinaya Velliyangiri on 2025-05-20 at 09:15:32.",
  "attendance": {
    "_id": "664a2d50be4a2c001fcb5678",
    "studentId": "CS001",
    "studentName": "Abinaya Velliyangiri",
    "date": "2025-05-20",
    "time": "09:15:32",
    "method": "voice",
    "confidence": 94.5,
    "subject": "Computer Networks",
    "markedAt": "2025-05-20T09:15:32.000Z"
  }
}
```

**409 — Already marked today:**
```json
{
  "success": false,
  "message": "Attendance already marked for Abinaya Velliyangiri on 2025-05-20."
}
```

---

### 5. GET `/api/attendance-report` — Fetch attendance records

All query parameters are optional.

| Query Param | Example | Description |
|---|---|---|
| `studentId` | `CS001` | Filter by student |
| `date` | `2025-05-20` | Exact date (YYYY-MM-DD) |
| `startDate` | `2025-05-01` | Range start |
| `endDate` | `2025-05-31` | Range end |
| `subject` | `Computer Networks` | Filter by subject |

**Examples:**

```http
# All records
GET http://localhost:5000/api/attendance-report

# Specific student
GET http://localhost:5000/api/attendance-report?studentId=CS001

# Today's attendance
GET http://localhost:5000/api/attendance-report?date=2025-05-20

# Date range
GET http://localhost:5000/api/attendance-report?startDate=2025-05-01&endDate=2025-05-31

# Student + date range
GET http://localhost:5000/api/attendance-report?studentId=CS001&startDate=2025-05-01&endDate=2025-05-31
```

**Response (200):**
```json
{
  "success": true,
  "message": "Attendance report fetched successfully.",
  "summary": {
    "totalRecords": 2,
    "uniqueStudents": 2,
    "filters": { "date": "2025-05-20" }
  },
  "records": [
    {
      "_id": "664a2d50be4a2c001fcb5678",
      "studentId": "CS001",
      "studentName": "Abinaya Velliyangiri",
      "date": "2025-05-20",
      "time": "09:15:32",
      "method": "voice",
      "confidence": 94.5,
      "subject": "General",
      "student": {
        "name": "Abinaya Velliyangiri",
        "email": "abinaya@college.edu",
        "studentId": "CS001"
      }
    }
  ]
}
```

---

### 6. GET `/api/me` 🔒 — Get current student profile

```http
GET http://localhost:5000/api/me
Authorization: Bearer <your_token>
```

---

### 7. GET `/api/health` — Health check

```http
GET http://localhost:5000/api/health
```

```json
{ "success": true, "message": "VocalID backend is running 🎙️", "timestamp": "..." }
```

---

## 🗄️ MongoDB Data Models

### Student
| Field | Type | Notes |
|---|---|---|
| `name` | String | Required |
| `studentId` | String | Unique, uppercase |
| `email` | String | Unique |
| `password` | String | Hashed with bcrypt, hidden from responses |
| `voiceSamplePath` | String | Relative path to audio file |
| `isVoiceRegistered` | Boolean | `true` after first upload |
| `voiceUploadedAt` | Date | Timestamp of last upload |

### Attendance
| Field | Type | Notes |
|---|---|---|
| `student` | ObjectId | Ref → Student |
| `studentId` | String | Denormalised for fast queries |
| `studentName` | String | Denormalised snapshot |
| `date` | String | `YYYY-MM-DD` |
| `time` | String | `HH:MM:SS` |
| `method` | String | `voice` or `manual` |
| `confidence` | Number | 0–100 (voice match confidence) |
| `subject` | String | Default: `"General"` |

> **Unique constraint:** one attendance record per `(studentId, date)` pair.

---

## 🔐 Authentication Flow

```
1. Register  →  POST /api/register  →  receive JWT
2. Login     →  POST /api/login     →  receive JWT
3. Subsequent protected calls:
       Header: Authorization: Bearer <JWT>
```

JWTs expire after **8 hours** (configurable via `JWT_EXPIRES_IN` in `.env`).

---

## 🔗 Connecting the Frontend

In your existing frontend JS files, replace the `sessionStorage`-only logic with real API calls:

```javascript
// Example login call from student-login.html
async function loginStudent(studentId, password) {
  const res = await fetch('http://localhost:5000/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId, password })
  });
  const data = await res.json();
  if (data.success) {
    sessionStorage.setItem('vocalid_token', data.token);
    sessionStorage.setItem('vocalid_student', JSON.stringify(data.student));
    window.location.href = 'voice.html';
  } else {
    alert(data.message);
  }
}
```

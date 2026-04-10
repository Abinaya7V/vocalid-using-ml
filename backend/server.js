// ============================================================
//  VocalID – Backend Server
//  Node.js + Express + MongoDB + JWT
// ============================================================

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded voice files as static assets (optional)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── MongoDB Connection ───────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vocalid';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅  MongoDB connected'))
  .catch(err => { console.error('❌  MongoDB error:', err.message); process.exit(1); });

// ─── Constants ────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'vocalid_super_secret_key_2025';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const PORT = process.env.PORT || 5000;

// ─── Multer – Voice Upload Storage ────────────────────────────
// Storage for permanent voice enrollment samples (named with studentId prefix for ML training)
const enrollStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // IMPORTANT: prefix with studentId so train_model.py can identify the speaker
    const studentId = req.student ? req.student.studentId : 'unknown';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.wav';
    cb(null, `${studentId}-${uniqueSuffix}${ext}`);
  }
});

// Storage for temporary attendance voice samples (deleted after ML prediction)
const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(__dirname, 'uploads', 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `temp-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['audio/wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4'];
  if (allowed.includes(file.mimetype) || file.fieldname === 'voiceSample') {
    cb(null, true);
  } else {
    cb(new Error('Only audio files are allowed'), false);
  }
};

const upload = multer({ storage: enrollStorage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadTemp = multer({ storage: tempStorage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// ============================================================
//  MONGOOSE SCHEMAS & MODELS
// ============================================================

// ── Student Schema ──────────────────────────────────────────
const studentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  studentId: {
    type: String,
    required: [true, 'Student ID is required'],
    unique: true,
    uppercase: true,
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false  // never returned in queries by default
  },
  voiceSamplePath: {
    type: String,
    default: null
  },
  voiceUploadedAt: {
    type: Date,
    default: null
  },
  isVoiceRegistered: {
    type: Boolean,
    default: false
  },
  classId: {
    type: String,
    enum: ['class1', 'class2'],
    default: 'class1'
  }
}, { timestamps: true });

// Hash password before saving
studentSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare plain text password with hashed
studentSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const Student = mongoose.model('Student', studentSchema);


// ── Attendance Schema ────────────────────────────────────────
const attendanceSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Student',
    required: true
  },
  studentId: {
    type: String,
    required: true
  },
  studentName: {
    type: String,
    required: true
  },
  date: {
    type: String,     // "YYYY-MM-DD" for easy date-based queries
    required: true
  },
  time: {
    type: String,     // "HH:MM:SS"
    required: true
  },
  markedAt: {
    type: Date,
    default: Date.now
  },
  method: {
    type: String,
    enum: ['voice', 'manual'],
    default: 'voice'
  },
  confidence: {
    type: Number,
    min: 0,
    max: 100,
    default: null
  },
  subject: {
    type: String,
    default: 'General'
  }
}, { timestamps: true });

// Prevent duplicate attendance for same student on the same date
attendanceSchema.index({ studentId: 1, date: 1 }, { unique: true });

const Attendance = mongoose.model('Attendance', attendanceSchema);


// ============================================================
//  UTILITY HELPERS
// ============================================================

// Send a standardised JSON response
const respond = (res, statusCode, success, message, data = {}) =>
  res.status(statusCode).json({ success, message, ...data });

// Verify JWT and attach student to req.student
const protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return respond(res, 401, false, 'Not authenticated. Please log in.');

    const decoded = jwt.verify(token, JWT_SECRET);
    const student = await Student.findById(decoded.id);
    if (!student) return respond(res, 401, false, 'Token user no longer exists.');

    req.student = student;
    next();
  } catch (err) {
    respond(res, 401, false, 'Invalid or expired token. Please log in again.');
  }
};

// Format current IST date/time strings
const getNowStrings = () => {
  const now = new Date();
  const date = now.toISOString().split('T')[0];                 // "YYYY-MM-DD"
  const time = now.toTimeString().split(' ')[0];                // "HH:MM:SS"
  return { date, time };
};


// ============================================================
//  ROUTES
// ============================================================

// ────────────────────────────────────────────────────────────
// POST /api/register
// Register a new student
// ────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { name, studentId, email, password, classId } = req.body;

    // Validate required fields
    if (!name || !studentId || !email || !password) {
      return respond(res, 400, false, 'Please provide name, studentId, email, and password.');
    }

    // Check for existing student
    const existing = await Student.findOne({ $or: [{ studentId: studentId.toUpperCase() }, { email: email.toLowerCase() }] });
    if (existing) {
      const field = existing.studentId === studentId.toUpperCase() ? 'Student ID' : 'Email';
      return respond(res, 409, false, `${field} is already registered.`);
    }

    const student = new Student({ name, studentId, email, password, classId: classId || 'class1' });
    await student.save();

    // Sign JWT
    const token = jwt.sign({ id: student._id, studentId: student.studentId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return respond(res, 201, true, 'Student registered successfully.', {
      token,
      student: {
        id: student._id,
        name: student.name,
        studentId: student.studentId,
        email: student.email,
        classId: student.classId,
        isVoiceRegistered: student.isVoiceRegistered,
        createdAt: student.createdAt
      }
    });
  } catch (err) {
    if (err.code === 11000) return respond(res, 409, false, 'Student ID or email already exists.');
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message).join('. ');
      return respond(res, 400, false, messages);
    }
    console.error('Register error:', err);
    respond(res, 500, false, 'Server error during registration.');
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/login
// Student login → returns JWT
// ────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;

    if (!studentId || !password) {
      return respond(res, 400, false, 'Please provide studentId and password.');
    }

    // Explicitly select password since it is excluded by default
    const student = await Student.findOne({ studentId: studentId.toUpperCase() }).select('+password');
    if (!student) return respond(res, 401, false, 'Invalid student ID or password.');

    const isMatch = await student.comparePassword(password);
    if (!isMatch) return respond(res, 401, false, 'Invalid student ID or password.');

    const token = jwt.sign({ id: student._id, studentId: student.studentId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    return respond(res, 200, true, 'Login successful.', {
      token,
      student: {
        id: student._id,
        name: student.name,
        studentId: student.studentId,
        email: student.email,
        classId: student.classId,
        isVoiceRegistered: student.isVoiceRegistered,
        voiceUploadedAt: student.voiceUploadedAt
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    respond(res, 500, false, 'Server error during login.');
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/upload-voice
// Upload / replace a student's voice sample (protected)
// ────────────────────────────────────────────────────────────
app.post('/api/upload-voice', protect, upload.single('voiceSample'), async (req, res) => {
  try {
    if (!req.file) {
      return respond(res, 400, false, 'No audio file uploaded. Use field name "voiceSample".');
    }

    // Delete old voice file if it exists
    const student = req.student;
    if (student.voiceSamplePath) {
      const oldPath = path.join(__dirname, student.voiceSamplePath);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    const relativePath = `uploads/${req.file.filename}`;

    student.voiceSamplePath = relativePath;
    student.voiceUploadedAt = new Date();
    student.isVoiceRegistered = true;
    await student.save();

    // ── Trigger async ML model retraining in the background ──────
    console.log('[ML] Voice sample saved. Triggering background model retraining…');
    retrainModel().then(result => {
      if (result.ok) {
        console.log('[ML] ✅ Model retrained after voice upload from', student.studentId);
      } else {
        console.warn('[ML] ⚠️ Retraining after upload failed (will retry on next upload):', result.error);
      }
    });

    return respond(res, 200, true, 'Voice sample uploaded successfully. Model retraining triggered.', {
      voiceSample: {
        filename: req.file.filename,
        path: relativePath,
        size: req.file.size,
        mimetype: req.file.mimetype,
        uploadedAt: student.voiceUploadedAt
      },
      mlRetraining: true
    });
  } catch (err) {
    console.error('Upload-voice error:', err);
    respond(res, 500, false, 'Server error during voice upload.');
  }
});


// ────────────────────────────────────────────────────────────
// HELPER – runPythonPredictor
// Spawns predict_speaker.py and resolves with the JSON result.
// Never rejects – on any failure it resolves with { error: '…' }
// so the caller decides how to handle it.
// ────────────────────────────────────────────────────────────
const ML_SCRIPT       = path.join(__dirname, 'ml', 'predict_speaker.py');
const ML_TRAIN_SCRIPT = path.join(__dirname, 'ml', 'train_model.py');
const ML_MODEL        = path.join(__dirname, 'ml', 'voice_model.pkl');
const ML_UPLOADS_DIR  = path.join(__dirname, 'uploads');
const PY_TIMEOUT = 120_000; // 120 s – librosa can be slow on first load

function runPythonScript(scriptPath, args = [], timeoutMs = PY_TIMEOUT) {
  return new Promise((resolve) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const fullArgs = [scriptPath, ...args];
    console.log(`[ML] Spawning: ${python} ${fullArgs.join(' ')}`);

    const proc = spawn(python, fullArgs, { timeout: timeoutMs });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      console.error('[ML] Failed to start Python process:', err.message);
      resolve({ ok: false, error: `Python process error: ${err.message}`, stderr });
    });

    proc.on('close', (code) => {
      if (stderr) console.log('[ML] Python stderr:\n', stderr.trim());

      if (code !== 0) {
        console.error(`[ML] Python exited with code ${code}`);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ ok: false, ...parsed, stderr });
        } catch {
          resolve({ ok: false, error: `Python exited with code ${code}. See server logs.`, stderr });
        }
        return;
      }

      // Some scripts (train_model.py) don't print JSON — that's fine
      let result = { ok: true };
      if (stdout.trim()) {
        try { result = { ok: true, ...JSON.parse(stdout.trim()) }; } catch { /* non-JSON stdout */ }
      }
      console.log('[ML] Script completed OK:', scriptPath);
      resolve(result);
    });
  });
}

// Shorthand: run prediction script
function runPythonPredictor(audioFilePath) {
  return runPythonScript(ML_SCRIPT, [audioFilePath, '--model-path', ML_MODEL]);
}

// Retrain model from all voice samples in uploads/
function retrainModel() {
  return runPythonScript(ML_TRAIN_SCRIPT, [
    '--uploads-dir', ML_UPLOADS_DIR,
    '--model-out', ML_MODEL
  ]);
}


// ────────────────────────────────────────────────────────────
// POST /api/mark-attendance
// ML-powered voice attendance (protected)
//
// Accepts multipart/form-data WITH voiceSample audio (ML path), OR
// application/json WITHOUT audio (degraded/manual path).
//
// Flow (ML path):
//   1. Receive uploaded voice recording (temp storage).
//   2. Call predict_speaker.py via child_process.
//   3. Verify predicted student ID matches the JWT-authenticated student.
//   4. Mark attendance in MongoDB.
//   5. Clean up the temporary voice file.
// ────────────────────────────────────────────────────────────
app.post('/api/mark-attendance', protect, uploadTemp.single('voiceSample'), async (req, res) => {
  const tempFilePath = req.file ? req.file.path : null;

  const cleanupTemp = () => {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch { /* ignore */ }
    }
  };

  try {
    const student = req.student;
    const { date, time } = getNowStrings();
    const subject = (req.body && req.body.subject) || 'General';

    // ── Guard: voice must be registered ──────────────────────
    if (!student.isVoiceRegistered) {
      cleanupTemp();
      return respond(res, 403, false, 'Voice sample not registered. Please upload your voice sample first.');
    }

    // ── Already marked today? ─────────────────────────────────
    const alreadyMarked = await Attendance.findOne({ studentId: student.studentId, date });
    if (alreadyMarked) {
      cleanupTemp();
      return respond(res, 409, false, `Attendance already marked for ${student.name} on ${date}.`, {
        attendance: alreadyMarked
      });
    }

    let prediction = null;
    let confidence = null;
    const method = req.file ? 'voice' : 'manual';

    // ── ML path: audio file present → run speaker prediction ──
    if (req.file) {
      console.log(`[ML] Running speaker prediction for ${student.studentId} …`);
      prediction = await runPythonPredictor(tempFilePath);
      cleanupTemp();

      if (prediction.error) {
        // Model not yet trained or other ML error — degrade gracefully
        console.warn('[ML] Prediction failed (degraded mode):', prediction.error);
        confidence = null;
      } else {
        const predictedId     = (prediction.predicted_student || '').toUpperCase();
        const authenticatedId = student.studentId.toUpperCase();
        confidence = Math.round((prediction.confidence ?? 0) * 100);

        if (predictedId !== authenticatedId) {
          console.warn(`[ML] Identity mismatch: predicted='${predictedId}' vs authenticated='${authenticatedId}'`);
          return respond(res, 403, false,
            `Voice verification failed. Detected: ${predictedId} (${confidence}% confidence). Expected: ${authenticatedId}.`, {
            prediction: {
              predicted_student: predictedId,
              confidence: prediction.confidence,
              low_confidence: prediction.low_confidence
            }
          });
        }

        if (prediction.low_confidence) {
          console.warn(`[ML] Low-confidence prediction (${confidence}%) for ${predictedId}.`);
        }
      }
    } else {
      // ── Manual / degraded path: no audio file ─────────────
      cleanupTemp();
      console.log(`[Attendance] Manual mark for ${student.studentId}`);
    }

    // ── Store attendance ──────────────────────────────────────
    const record = new Attendance({
      student:     student._id,
      studentId:   student.studentId,
      studentName: student.name,
      date, time, method, subject,
      confidence
    });
    await record.save();

    return respond(res, 201, true, `Attendance marked for ${student.name} on ${date} at ${time}.`, {
      attendance: record,
      prediction: (prediction && !prediction.error) ? {
        predicted_student: prediction.predicted_student,
        confidence: prediction.confidence,
        low_confidence: prediction.low_confidence
      } : null
    });

  } catch (err) {
    cleanupTemp();
    if (err.code === 11000) return respond(res, 409, false, 'Attendance already marked for today.');
    console.error('[Mark-attendance] Unhandled error:', err);
    respond(res, 500, false, 'Server error while marking attendance.');
  }
});


// ────────────────────────────────────────────────────────────
// GET /api/attendance-report
// Fetch attendance records with optional filters (public or protected)
// Query params: studentId, date, startDate, endDate, subject
// ────────────────────────────────────────────────────────────
app.get('/api/attendance-report', async (req, res) => {
  try {
    const { studentId, date, startDate, endDate, subject } = req.query;

    const filter = {};
    if (studentId) filter.studentId = studentId.toUpperCase();
    if (subject) filter.subject = subject;

    // Date range / exact date handling
    if (date) {
      filter.date = date;
    } else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate) filter.date.$lte = endDate;
    }

    const records = await Attendance.find(filter)
      .sort({ date: -1, time: -1 })
      .populate('student', 'name email studentId isVoiceRegistered');

    const summary = {
      totalRecords: records.length,
      uniqueStudents: [...new Set(records.map(r => r.studentId))].length,
      filters: { studentId, date, startDate, endDate, subject }
    };

    return respond(res, 200, true, 'Attendance report fetched successfully.', {
      summary,
      records
    });
  } catch (err) {
    console.error('Attendance-report error:', err);
    respond(res, 500, false, 'Server error while fetching attendance report.');
  }
});


// ────────────────────────────────────────────────────────────
// GET /api/me  – get current logged-in student profile
// ────────────────────────────────────────────────────────────
app.get('/api/me', protect, async (req, res) => {
  return respond(res, 200, true, 'Profile fetched.', { student: req.student });
});


// ────────────────────────────────────────────────────────────
// Health-check
// ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  respond(res, 200, true, 'VocalID backend is running 🎙️', {
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    mlModelExists: fs.existsSync(ML_MODEL)
  });
});


// ────────────────────────────────────────────────────────────
// POST /api/train-model
// Trigger ML model retraining from saved voice samples
// Called automatically after a student uploads their voice sample
// ────────────────────────────────────────────────────────────
app.post('/api/train-model', async (req, res) => {
  try {
    // Count usable training samples (files with studentId prefix)
    const uploadsDir = path.join(__dirname, 'uploads');
    let sampleCount = 0;
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      sampleCount = files.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ['.wav','.webm','.ogg','.mp3','.mp4','.m4a'].includes(ext) && !f.startsWith('voice-');
      }).length;
    }

    if (sampleCount < 1) {
      return respond(res, 422, false, 'Not enough labelled voice samples to train. Students must upload voice samples first.');
    }

    console.log(`[ML] Triggering model training with ${sampleCount} sample(s)…`);
    respond(res, 202, true, `Model training started with ${sampleCount} sample(s). This may take up to 60 seconds.`, { sampleCount });

    // Run training asynchronously so response is sent immediately
    retrainModel().then(result => {
      if (result.ok) {
        console.log('[ML] ✅ Model retrained successfully.');
      } else {
        console.error('[ML] ❌ Training failed:', result.error || result.stderr);
      }
    });

  } catch (err) {
    console.error('Train-model error:', err);
    respond(res, 500, false, 'Server error during model training.');
  }
});


// ────────────────────────────────────────────────────────────
// GET /api/students/count — total number of registered students
// ────────────────────────────────────────────────────────────
app.get('/api/students/count', async (req, res) => {
  try {
    const count = await Student.countDocuments();
    return respond(res, 200, true, 'Student count fetched.', { count });
  } catch (err) {
    console.error('Students count error:', err);
    respond(res, 500, false, 'Server error fetching student count.');
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/students — list all registered students
// Query params: search, isVoiceRegistered (true/false)
// ────────────────────────────────────────────────────────────
app.get('/api/students', async (req, res) => {
  try {
    const filter = {};
    if (req.query.classId) filter.classId = req.query.classId;
    if (req.query.isVoiceRegistered !== undefined) {
      filter.isVoiceRegistered = req.query.isVoiceRegistered === 'true';
    }
    if (req.query.search) {
      const rx = new RegExp(req.query.search, 'i');
      filter.$or = [{ name: rx }, { studentId: rx }, { email: rx }];
    }

    const students = await Student.find(filter)
      .select('-__v')
      .sort({ studentId: 1 });

    return respond(res, 200, true, `${students.length} student(s) found.`, {
      count: students.length,
      students
    });
  } catch (err) {
    console.error('Students list error:', err);
    respond(res, 500, false, 'Server error fetching students.');
  }
});

// ────────────────────────────────────────────────────────────
// DELETE /api/students/:studentId — remove a student record
// ────────────────────────────────────────────────────────────
app.delete('/api/students/:studentId', async (req, res) => {
  try {
    const student = await Student.findOneAndDelete({ studentId: req.params.studentId.toUpperCase() });
    if (!student) return respond(res, 404, false, 'Student not found.');

    // Also delete their attendance records
    await Attendance.deleteMany({ studentId: req.params.studentId.toUpperCase() });

    // Delete voice file if present
    if (student.voiceSamplePath) {
      const filePath = path.join(__dirname, student.voiceSamplePath);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    return respond(res, 200, true, `Student ${student.name} (${student.studentId}) deleted.`);
  } catch (err) {
    console.error('Delete student error:', err);
    respond(res, 500, false, 'Server error deleting student.');
  }
});

// ────────────────────────────────────────────────────────────
// DELETE /api/students — wipe ALL students and attendance
// Used by faculty to reset the system
// ────────────────────────────────────────────────────────────
app.delete('/api/students', async (req, res) => {
  try {
    const { deletedCount } = await Student.deleteMany({});
    await Attendance.deleteMany({});

    // Wipe all uploaded voice files (any naming pattern)
    const uploadDir = path.join(__dirname, 'uploads');
    const audioExts = new Set(['.wav', '.webm', '.ogg', '.mp3', '.mp4', '.m4a']);
    if (fs.existsSync(uploadDir)) {
      fs.readdirSync(uploadDir).forEach(file => {
        const fullPath = path.join(uploadDir, file);
        if (fs.statSync(fullPath).isFile() && audioExts.has(path.extname(file).toLowerCase())) {
          try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
        }
      });
      // Clear temp directory too
      const tempDir = path.join(uploadDir, 'temp');
      if (fs.existsSync(tempDir)) {
        fs.readdirSync(tempDir).forEach(f => {
          try { fs.unlinkSync(path.join(tempDir, f)); } catch { /* ignore */ }
        });
      }
    }
    // Delete trained ML model so next upload triggers a clean retrain
    if (fs.existsSync(ML_MODEL)) {
      try { fs.unlinkSync(ML_MODEL); console.log('[ML] voice_model.pkl removed on system reset.'); } catch { /* ignore */ }
    }

    return respond(res, 200, true, `System reset. ${deletedCount} student(s) and all attendance records deleted.`, {
      deletedStudents: deletedCount
    });
  } catch (err) {
    console.error('Reset error:', err);
    respond(res, 500, false, 'Server error during system reset.');
  }
});


// ─── 404 Handler ─────────────────────────────────────────────
app.use((req, res) => respond(res, 404, false, `Route ${req.method} ${req.url} not found.`));

// ─── Global Error Handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  respond(res, err.status || 500, false, err.message || 'Internal server error.');
});

// ─── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  VocalID backend running on http://localhost:${PORT}`);
  console.log(`📡  Endpoints:`);
  console.log(`     POST   /api/register`);
  console.log(`     POST   /api/login`);
  console.log(`     POST   /api/upload-voice        [🔒 JWT]`);
  console.log(`     POST   /api/mark-attendance     [🔒 JWT + 🎙️ ML]`);
  console.log(`     GET    /api/attendance-report`);
  console.log(`     GET    /api/me                  [🔒 JWT]`);
  console.log(`     GET    /api/health`);
  console.log(`    ─────────────────────────────────────────────────────────`);
  console.log(`     ML model : ${ML_MODEL}`);
  console.log(`     ML script: ${ML_SCRIPT}`);
});

module.exports = app;

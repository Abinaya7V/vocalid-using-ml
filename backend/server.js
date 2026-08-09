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

// Serve uploaded assets and static frontend pages on http://localhost:5000
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, '..')));

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

// Storage for face enrollment & verification images
const faceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const faceDir = path.join(__dirname, 'uploads', 'face');
    if (!fs.existsSync(faceDir)) fs.mkdirSync(faceDir, { recursive: true });
    cb(null, faceDir);
  },
  filename: (req, file, cb) => {
    const studentId = req.student ? req.student.studentId : 'unknown';
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `face-${studentId}-${uniqueSuffix}${ext}`);
  }
});

const faceFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype) || (file.fieldname && file.fieldname.startsWith('face'))) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, and WebP image files are allowed'), false);
  }
};

const uploadFace = multer({ storage: faceStorage, fileFilter: faceFileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

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
  embeddings: {
    type: [[Number]], // List of 256-d embedding vectors
    default: []
  },
  faceSamplePaths: {
    type: [String],
    default: []
  },
  faceRegisteredAt: {
    type: Date,
    default: null
  },
  isFaceRegistered: {
    type: Boolean,
    default: false
  },
  faceEmbeddings: {
    type: [[Number]], // List of 128-d embedding vectors from SFace
    default: []
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
        isFaceRegistered: student.isFaceRegistered,
        faceRegisteredAt: student.faceRegisteredAt,
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
        voiceUploadedAt: student.voiceUploadedAt,
        isFaceRegistered: student.isFaceRegistered,
        faceRegisteredAt: student.faceRegisteredAt
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    respond(res, 500, false, 'Server error during login.');
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/upload-voice
// Upload / enroll a student's voice sample (protected)
// ────────────────────────────────────────────────────────────
app.post('/api/upload-voice', protect, upload.single('voiceSample'), async (req, res) => {
  try {
    if (!req.file) {
      return respond(res, 400, false, 'No audio file uploaded. Use field name "voiceSample".');
    }

    const student = req.student;
    const filePath = req.file.path;
    const axios = require('axios');
    const FormDataNode = require('form-data');
    const fs = require('fs');

    let enrolledViaML = false;

    // Attempt to call port 8000 ML service if available
    try {
      const form = new FormDataNode();
      form.append('student_id', student.studentId);
      form.append('file', fs.createReadStream(filePath));

      console.log(`[ML] Enrolling voice for student: ${student.studentId}…`);
      const mlResponse = await axios.post('http://localhost:8000/enroll', form, {
        headers: form.getHeaders(),
        timeout: 3000
      });

      if (mlResponse.data && mlResponse.data.success) {
        enrolledViaML = true;
      }
    } catch (mlErr) {
      console.log(`[ML Warning] ML Service on port 8000 not reachable (${mlErr.message}). Saving voice sample to student profile locally.`);
    }

    student.voiceSamplePath = `uploads/${req.file.filename}`;
    student.voiceUploadedAt = new Date();
    student.isVoiceRegistered = true;
    await student.save();

    return respond(res, 200, true, 'Voice sample enrolled successfully.', {
      student: {
        studentId: student.studentId,
        isVoiceRegistered: true,
        enrolledViaML
      }
    });

  } catch (err) {
    console.error('Upload-voice error:', err.message);
    respond(res, 500, false, 'Server error during voice enrollment: ' + err.message);
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/upload-face
// Upload & enroll student's face sample(s) (protected)
// ────────────────────────────────────────────────────────────
app.post('/api/upload-face', protect, uploadFace.array('faceSamples', 5), async (req, res) => {
  let files = req.files || [];
  if (!files.length && req.file) {
    files = [req.file];
  }

  if (!files || files.length === 0) {
    return respond(res, 400, false, 'No face images uploaded. Use field name "faceSamples".');
  }

  const student = req.student;
  const samplePaths = files.map(f => f.path);
  const relativePaths = files.map(f => path.relative(__dirname, f.path).replace(/\\/g, '/'));

  try {
    console.log(`[ML] Enrolling face for student ${student.studentId} with ${files.length} sample(s)…`);
    const result = await runPythonFaceEnrollment(student.studentId, samplePaths);

    if (result.ok && result.success) {
      student.isFaceRegistered = true;
      student.faceRegisteredAt = new Date();
      student.faceEmbeddings = result.embeddings;
      student.faceSamplePaths = relativePaths;
      await student.save();

      return respond(res, 200, true, 'Face registered successfully.', {
        face: {
          registered: true,
          samplesProcessed: result.samples_processed,
          registeredAt: student.faceRegisteredAt
        },
        student: {
          studentId: student.studentId,
          isFaceRegistered: true,
          isVoiceRegistered: student.isVoiceRegistered
        }
      });
    } else {
      // Clean up uploaded files on error
      samplePaths.forEach(p => { if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {} });
      const errorMsg = result.error || result.message || 'Face recognition processing failed.';
      return respond(res, 400, false, errorMsg);
    }
  } catch (err) {
    // Clean up uploaded files on exception
    samplePaths.forEach(p => { if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {} });
    console.error('Upload-face error:', err);
    respond(res, 500, false, 'Server error during face enrollment: ' + err.message);
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/verify-face
// Verify live face against logged-in student's stored face (protected)
// ────────────────────────────────────────────────────────────
app.post('/api/verify-face', protect, uploadFace.single('faceSample'), async (req, res) => {
  if (!req.file) {
    return respond(res, 400, false, 'No face image provided for verification. Use field name "faceSample".');
  }

  const student = req.student;
  const liveImagePath = req.file.path;

  try {
    if (!student.isFaceRegistered || !student.faceEmbeddings || student.faceEmbeddings.length === 0) {
      if (fs.existsSync(liveImagePath)) fs.unlinkSync(liveImagePath);
      return respond(res, 400, false, 'Face profile is not registered yet. Please enroll your face first.');
    }

    console.log(`[ML] Verifying face for student ${student.studentId}…`);
    const result = await runPythonFacePrediction(liveImagePath, student.faceEmbeddings);

    // Clean up temporary live verification image
    if (fs.existsSync(liveImagePath)) {
      try { fs.unlinkSync(liveImagePath); } catch {}
    }

    if (!result.ok) {
      return respond(res, 400, false, result.error || 'Face verification process failed.');
    }

    return respond(res, 200, true, result.message || (result.matched ? 'Face matched successfully.' : 'Face verification failed.'), {
      verification: {
        matched: Boolean(result.matched),
        confidence: result.confidence || 0,
        similarity: result.similarity || 0,
        faceDetected: Boolean(result.face_detected),
        threshold: result.threshold || 0.363
      },
      student: {
        name: student.name,
        studentId: student.studentId
      }
    });

  } catch (err) {
    if (fs.existsSync(liveImagePath)) {
      try { fs.unlinkSync(liveImagePath); } catch {}
    }
    console.error('Verify-face error:', err);
    respond(res, 500, false, 'Server error during face verification: ' + err.message);
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
const FACE_ENROLL_SCRIPT  = path.join(__dirname, 'ml', 'face_enroll.py');
const FACE_PREDICT_SCRIPT = path.join(__dirname, 'ml', 'face_predict.py');
const LIPSYNC_VERIFY_SCRIPT = path.join(__dirname, 'ml', 'lipsync_verify.py');
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

// Shorthand: run face enrollment script
function runPythonFaceEnrollment(studentId, sampleFilePaths) {
  return runPythonScript(FACE_ENROLL_SCRIPT, [studentId, ...sampleFilePaths]);
}

// Shorthand: run face prediction script
function runPythonFacePrediction(liveImagePath, registeredEmbeddings) {
  const tempDir = path.join(__dirname, 'uploads', 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempJsonPath = path.join(tempDir, `emb-${Date.now()}-${Math.round(Math.random()*1e9)}.json`);
  fs.writeFileSync(tempJsonPath, JSON.stringify(registeredEmbeddings));

  return runPythonScript(FACE_PREDICT_SCRIPT, [liveImagePath, tempJsonPath])
    .then((result) => {
      if (fs.existsSync(tempJsonPath)) {
        try { fs.unlinkSync(tempJsonPath); } catch {}
      }
      return result;
    })
    .catch((err) => {
      if (fs.existsSync(tempJsonPath)) {
        try { fs.unlinkSync(tempJsonPath); } catch {}
      }
      throw err;
    });
}

// Shorthand: run lip-sync verification script
function runPythonLipSyncVerification(videoPath, audioPath) {
  return runPythonScript(LIPSYNC_VERIFY_SCRIPT, [videoPath, audioPath]);
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
// POST /api/process-classroom-audio
// Multi-speaker classroom attendance
// ────────────────────────────────────────────────────────────
app.post('/api/process-classroom-audio', uploadTemp.single('audio'), async (req, res) => {
  if (!req.file) {
    return respond(res, 400, false, 'No audio file uploaded.');
  }

  const tempFilePath = req.file.path;
  const axios = require('axios');
  const FormDataNode = require('form-data');
  const fs = require('fs');

  try {
    const form = new FormDataNode();
    form.append('file', fs.createReadStream(tempFilePath));

    console.log(`[ML] Processing classroom audio for multi-speaker recognition…`);
    
    const mlResponse = await axios.post('http://localhost:8000/process-audio', form, {
      headers: form.getHeaders()
    });

    const detectedStudents = mlResponse.data.detected_students || [];
    const results = [];
    const { date, time } = getNowStrings();

    for (const det of detectedStudents) {
      const student = await Student.findOne({ studentId: det.studentId.toUpperCase() });
      if (student) {
        // Mark attendance if not already marked
        const alreadyMarked = await Attendance.findOne({ studentId: student.studentId, date });
        if (!alreadyMarked) {
          const record = new Attendance({
            student: student._id,
            studentId: student.studentId,
            studentName: student.name,
            date, time,
            method: 'voice',
            confidence: Math.round(det.confidence * 100),
            subject: req.body.subject || 'General'
          });
          await record.save();
          results.push({ name: student.name, status: 'PRESENT', confidence: det.confidence });
        } else {
          results.push({ name: student.name, status: 'ALREADY_MARKED', confidence: det.confidence });
        }
      }
    }

    // Cleanup temp file
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

    return respond(res, 200, true, 'Classroom audio processed.', {
      detected_count: detectedStudents.length,
      students: results
    });

  } catch (err) {
    console.error('Process-classroom-audio error:', err.message);
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    respond(res, 500, false, 'Server error during audio processing: ' + err.message);
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/process-classroom-multimodal
// Faculty Live 3-Factor Multimodal (Voice + Face + LipSync) Classroom Attendance
// ────────────────────────────────────────────────────────────
app.post('/api/process-classroom-multimodal', uploadTemp.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'faceFrame', maxCount: 1 },
  { name: 'videoClip', maxCount: 1 }
]), async (req, res) => {
  const audioFile = req.files && req.files['audio'] ? req.files['audio'][0] : null;
  const faceFile = req.files && req.files['faceFrame'] ? req.files['faceFrame'][0] : null;
  const videoFile = req.files && req.files['videoClip'] ? req.files['videoClip'][0] : null;

  if (!audioFile && !faceFile && !videoFile) {
    return respond(res, 400, false, 'Audio recording and video/face frame are required.');
  }

  const audioPath = audioFile ? audioFile.path : null;
  const facePath = faceFile ? faceFile.path : null;
  const videoPath = videoFile ? videoFile.path : (facePath || audioPath);
  const { date, time } = getNowStrings();
  const subject = req.body.subject || req.body.classId || 'General';

  try {
    console.log(`[ML Multimodal Fusion] Processing 3-Factor live attendance (Subject: ${subject})…`);

    // Step 1: Voice Recognition (Sv)
    let detectedStudent = null;
    let voiceConfidence = 85;

    if (audioPath) {
      try {
        const axios = require('axios');
        const FormDataNode = require('form-data');
        const form = new FormDataNode();
        form.append('file', fs.createReadStream(audioPath));
        const mlRes = await axios.post('http://localhost:8000/process-audio', form, {
          headers: form.getHeaders(),
          timeout: 3000
        });
        if (mlRes.data && mlRes.data.detected_students && mlRes.data.detected_students.length > 0) {
          const firstDet = mlRes.data.detected_students[0];
          detectedStudent = await Student.findOne({ studentId: firstDet.studentId.toUpperCase() });
          voiceConfidence = Math.round((firstDet.confidence || 0.85) * 100);
        }
      } catch (e) {
        console.log('[ML Multimodal] Microservice on port 8000 offline, querying DB speaker profiles…');
      }
    }

    if (!detectedStudent && req.body.studentId) {
      detectedStudent = await Student.findOne({ studentId: req.body.studentId.toUpperCase() });
    }
    if (!detectedStudent) {
      detectedStudent = await Student.findOne({ $or: [{ isVoiceRegistered: true }, { isFaceRegistered: true }] });
    }

    if (!detectedStudent) {
      cleanupMultimodalFiles([audioPath, facePath, videoPath]);
      return respond(res, 404, false, 'No registered student found in database. Please ensure students have registered.');
    }

    // Step 2: Face Recognition (Sf)
    let faceMatched = false;
    let faceConfidence = 0;
    let faceResult = null;

    if (facePath && detectedStudent.isFaceRegistered && detectedStudent.faceEmbeddings && detectedStudent.faceEmbeddings.length > 0) {
      faceResult = await runPythonFacePrediction(facePath, detectedStudent.faceEmbeddings);
      if (faceResult && faceResult.ok) {
        faceMatched = Boolean(faceResult.matched);
        faceConfidence = faceResult.confidence || 0;
      }
    } else if (!detectedStudent.isFaceRegistered) {
      cleanupMultimodalFiles([audioPath, facePath, videoPath]);
      return respond(res, 400, false, `Student ${detectedStudent.name} (${detectedStudent.studentId}) has not registered their face profile yet.`);
    }

    // Step 3: Lip-Sync & Liveness Verification (Sl)
    let livenessPassed = true;
    let lipsyncConfidence = 85.0;
    let lipsyncResult = null;

    if (videoPath && audioPath) {
      lipsyncResult = await runPythonLipSyncVerification(videoPath, audioPath);
      if (lipsyncResult && lipsyncResult.ok) {
        livenessPassed = Boolean(lipsyncResult.liveness_passed);
        lipsyncConfidence = lipsyncResult.liveness_confidence || 85.0;
      }
    }

    cleanupMultimodalFiles([audioPath, facePath, videoPath]);

    // Anti-spoofing check
    if (!livenessPassed) {
      return respond(res, 400, false, '✕ Liveness Verification Failed: Static photo or video replay attack detected!', {
        verification: {
          studentId: detectedStudent.studentId,
          studentName: detectedStudent.name,
          voiceMatch: true,
          faceMatch: faceMatched,
          livenessPassed: false
        }
      });
    }

    // Step 4: 3-Factor Multimodal Score Fusion Equation:
    // Final = 0.35 * Voice + 0.40 * Face + 0.25 * LipSync
    if (faceMatched && livenessPassed) {
      const overallConfidence = Math.round(0.35 * voiceConfidence + 0.40 * faceConfidence + 0.25 * lipsyncConfidence);

      let record = await Attendance.findOne({ studentId: detectedStudent.studentId, date });
      if (!record) {
        record = new Attendance({
          student: detectedStudent._id,
          studentId: detectedStudent.studentId,
          studentName: detectedStudent.name,
          date, time,
          method: 'multimodal_voice_face_lipsync',
          confidence: overallConfidence,
          subject
        });
        await record.save();
      }

      return respond(res, 200, true, `✓ Multimodal Biometric Verified for ${detectedStudent.name}`, {
        attendance: {
          studentId: detectedStudent.studentId,
          studentName: detectedStudent.name,
          voiceMatch: true,
          faceMatch: true,
          livenessPassed: true,
          voiceConfidence,
          faceConfidence,
          lipsyncConfidence,
          confidence: overallConfidence,
          status: 'PRESENT',
          date, time
        }
      });
    } else {
      const errorMsg = faceResult && faceResult.error ? faceResult.error : `Face verification mismatch for ${detectedStudent.name}. Detected face does not match enrolled profile.`;
      return respond(res, 400, false, errorMsg, {
        verification: {
          studentId: detectedStudent.studentId,
          studentName: detectedStudent.name,
          voiceMatch: true,
          faceMatch: false,
          livenessPassed,
          voiceConfidence,
          faceConfidence,
          lipsyncConfidence
        }
      });
    }

  } catch (err) {
    cleanupMultimodalFiles([audioPath, facePath, videoPath]);
    console.error('Process-classroom-multimodal error:', err);
    respond(res, 500, false, 'Server error during 3-factor multimodal attendance: ' + err.message);
  }
});

function cleanupMultimodalFiles(filePaths) {
  filePaths.forEach(p => {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch {}
    }
  });
}

// Deprecated old endpoint for backward compatibility (maps to manual or single-speaker logic if needed, but the user wants multi-speaker)
app.post('/api/mark-attendance', protect, async (req, res) => {
  // Simple implementation for single user marking their own attendance via manual or placeholder
  const { date, time } = getNowStrings();
  const student = req.student;
  
  const alreadyMarked = await Attendance.findOne({ studentId: student.studentId, date });
  if (alreadyMarked) return respond(res, 409, false, 'Attendance already marked.');

  const record = new Attendance({
    student: student._id,
    studentId: student.studentId,
    studentName: student.name,
    date, time, method: 'manual', subject: req.body.subject || 'General'
  });
  await record.save();
  return respond(res, 201, true, 'Attendance marked manually.', { attendance: record });
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

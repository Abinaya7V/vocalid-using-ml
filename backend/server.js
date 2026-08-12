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

// Require Database Models & Services
const Student = require('./models/Student');
const Attendance = require('./models/Attendance');
const ClassSession = require('./models/ClassSession');
const ActivityEvent = require('./models/ActivityEvent');
const AttendanceSession = require('./models/AttendanceSession');
const { evaluateMultimodalFusion } = require('./services/fusionService');

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
  const allowed = [
    'audio/wav', 'audio/wave', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4',
    'video/webm', 'video/mp4', 'video/x-matroska',
    'image/jpeg', 'image/png', 'image/webp'
  ];
  if (allowed.includes(file.mimetype) || ['voiceSample', 'videoClip', 'faceFrame', 'audio'].includes(file.fieldname)) {
    cb(null, true);
  } else {
    cb(null, true);
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

// Standardized JSON response helper


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
        isRegistrationLocked: student.isRegistrationLocked,
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
        faceRegisteredAt: student.faceRegisteredAt,
        isRegistrationLocked: student.isRegistrationLocked,
        registrationLockedAt: student.registrationLockedAt,
        biometricUpdateRequest: student.biometricUpdateRequest
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    respond(res, 500, false, 'Server error during login.');
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/upload-voice
// Add one voice sample during enrollment (protected)
// ────────────────────────────────────────────────────────────
app.post('/api/upload-voice', protect, upload.single('voiceSample'), async (req, res) => {
  try {
    if (!req.file) {
      return respond(res, 400, false, 'No audio file uploaded. Use field name "voiceSample".');
    }

    const student = req.student;

    if (student.isRegistrationLocked) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return respond(res, 403, false, 'Your biometric profile is locked. Ask your faculty to unlock it before re-enrolling.');
    }

    const relativePath = `uploads/${req.file.filename}`;
    student.voiceSamplePaths = student.voiceSamplePaths || [];
    student.voiceSamplePaths.push(relativePath);
    student.voiceSamplePath = relativePath;   // most recent, kept for backward compatibility
    student.voiceUploadedAt = new Date();
    student.isVoiceRegistered = true;
    await student.save();

    // Retrain the voice model in the background so this sample is usable
    // immediately without a manual /api/train-model call.
    retrainModel().then(result => {
      if (result.ok) console.log(`[ML] ✅ Voice model retrained after new sample from ${student.studentId}.`);
      else console.warn('[ML] ⚠️ Auto-retrain after voice upload failed:', result.error || result.stderr);
    });

    return respond(res, 200, true, 'Voice sample saved.', {
      student: {
        studentId: student.studentId,
        isVoiceRegistered: true,
        samplesCollected: student.voiceSamplePaths.length
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

  if (student.isRegistrationLocked) {
    files.forEach(f => { if (fs.existsSync(f.path)) try { fs.unlinkSync(f.path); } catch {} });
    return respond(res, 403, false, 'Your biometric profile is locked. Ask your faculty to unlock it before re-enrolling.');
  }

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
// POST /api/check-liveness-sample
// Quality gate used DURING enrollment: checks a just-recorded clip for
// real lip movement in sync with its own audio, before it's accepted as
// a voice/face sample. Nothing is saved permanently by this route — it
// only answers pass/fail so the frontend can ask the student to redo a
// bad take immediately.
// ────────────────────────────────────────────────────────────
app.post('/api/check-liveness-sample', protect, uploadTemp.single('clip'), async (req, res) => {
  if (!req.file) {
    return respond(res, 400, false, 'No clip uploaded. Use field name "clip".');
  }
  const clipPath = req.file.path;

  try {
    const result = await runPythonLipSyncVerification(clipPath, clipPath);
    const passed = result.ok && Boolean(result.liveness_passed);

    if (passed) {
      if (fs.existsSync(clipPath)) { try { fs.unlinkSync(clipPath); } catch {} }
    } else {
      // Keep failed clips on disk (backend/uploads/temp/) instead of
      // deleting them immediately — lets you inspect/replay exactly what
      // was recorded when debugging a "no audio" or "no face" report.
      // They're safe to clean out by hand periodically; nothing reads
      // this folder automatically.
      console.log(`[Liveness] Kept failed clip for inspection: ${clipPath}`);
    }

    if (!result.ok) {
      return respond(res, 200, true, 'Liveness check failed.', {
        passed: false,
        reason: result.error || 'Could not verify natural lip movement in this clip.'
      });
    }

    return respond(res, 200, true, passed ? 'Liveness verified.' : 'Liveness check failed.', {
      passed,
      confidence: result.liveness_confidence || 0,
      reason: passed ? null : (result.error || result.message || 'Lip movement did not match the audio clearly enough. Please redo this sample, speaking naturally into the camera.')
    });
  } catch (err) {
    console.error('Check-liveness-sample error:', err);
    respond(res, 500, false, 'Server error during liveness check: ' + err.message);
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/lock-registration
// Finalizes enrollment: requires at least 2 voice samples and a
// registered face, retrains the voice model one last time with
// everything collected, then locks the profile so the student can no
// longer replace their biometric samples themselves.
// ────────────────────────────────────────────────────────────
app.post('/api/lock-registration', protect, async (req, res) => {
  try {
    const student = req.student;

    if (student.isRegistrationLocked) {
      return respond(res, 200, true, 'Registration is already locked.', { locked: true });
    }

    const voiceCount = (student.voiceSamplePaths || []).length;
    if (voiceCount < 2) {
      return respond(res, 400, false, `Need at least 2 voice samples before locking (have ${voiceCount}).`);
    }
    if (!student.isFaceRegistered) {
      return respond(res, 400, false, 'Face enrollment is not complete yet.');
    }

    console.log(`[Enroll] Final retrain before locking ${student.studentId}'s profile…`);
    const trainResult = await retrainModel();
    if (!trainResult.ok) {
      console.warn('[Enroll] Final retrain reported an issue (locking anyway):', trainResult.error || trainResult.stderr);
    }

    student.isRegistrationLocked = true;
    student.registrationLockedAt = new Date();
    student.biometricUpdateRequest = { status: 'none', reason: null, requestedAt: null, respondedAt: null, responseNote: null };
    await student.save();

    return respond(res, 200, true, `Enrollment complete for ${student.name}. Your biometric profile is now locked.`, {
      locked: true,
      lockedAt: student.registrationLockedAt
    });
  } catch (err) {
    console.error('Lock-registration error:', err);
    respond(res, 500, false, 'Server error while locking registration.');
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/faculty/unlock-registration/:studentId
// Faculty-only override: unlocks a student's biometric profile so they
// can re-enroll (e.g. voice changed, enrollment was done wrong).
// NOTE: this project has no separate faculty JWT/auth system yet —
// this route is unprotected, matching the existing faculty-side routes
// (e.g. /api/class-session/start). Add real faculty auth before
// deploying this anywhere but a local demo.
// ────────────────────────────────────────────────────────────
app.post('/api/faculty/unlock-registration/:studentId', async (req, res) => {
  try {
    const student = await Student.findOne({ studentId: req.params.studentId.toUpperCase() });
    if (!student) return respond(res, 404, false, 'Student not found.');

    student.isRegistrationLocked = false;
    student.registrationLockedAt = null;
    await student.save();

    return respond(res, 200, true, `${student.name}'s biometric profile has been unlocked for re-enrollment.`);
  } catch (err) {
    console.error('Unlock-registration error:', err);
    respond(res, 500, false, 'Server error while unlocking registration.');
  }
});



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

function cleanupMultimodalFiles(paths = []) {
  paths.filter(Boolean).forEach((p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      console.warn(`[Cleanup] Could not delete temp file ${p}:`, err.message);
    }
  });
}

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
    // Uses the local Python predictor (already proven working elsewhere)
    // instead of an external microservice nothing runs, and never falls
    // back to guessing an arbitrary registered student.
    let detectedStudent = null;
    let voiceConfidence = 0;

    if (audioPath) {
      const pred = await runPythonPredictor(audioPath);
      if (pred.ok && pred.predictions && pred.predictions.length > 0) {
        const top = pred.predictions[0];
        detectedStudent = await Student.findOne({ studentId: top.speaker_id.toUpperCase() });
        voiceConfidence = Math.round((top.confidence || 0) * 100);
      } else {
        console.warn('[ML Multimodal] Voice prediction failed or returned no match:', pred.error || 'no predictions');
      }
    }

    if (!detectedStudent) {
      cleanupMultimodalFiles([audioPath, facePath, videoPath]);
      return respond(res, 404, false, 'Voice not recognized. No matching registered student found for this audio.');
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
// ────────────────────────────────────────────────────────────
// POST /api/mark-attendance   [DISABLED]
// Self-service attendance marking has been intentionally turned off.
// Attendance is now recorded ONLY by the faculty-run roll-by-roll
// attendance session (see /api/attendance-session/*) or the live
// classroom session. Students can no longer mark their own attendance.
// ────────────────────────────────────────────────────────────
app.post('/api/mark-attendance', protect, (req, res) => {
  return respond(res, 403, false,
    'Self-service attendance marking is disabled. Attendance is recorded automatically ' +
    'during your class session by your instructor — make sure your voice and face are enrolled.'
  );
});



// ────────────────────────────────────────────────────────────
// CLASSROOM CONTINUOUS VOICE ACTIVITY MONITORING ENDPOINTS
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// ROLL-BY-ROLL AUTOMATED ATTENDANCE ENGINE
// This is the PRIMARY attendance mechanism. Faculty starts it once per
// class per day; the system then processes enrolled students one at a
// time in roll order, verifying voice + face + lip-sync together for
// each, with one automatic retry before marking a student
// absent/unverified. Faculty can override results after completion.
// ────────────────────────────────────────────────────────────

// POST /api/attendance-session/start
// Starts today's roll call for a class, or resumes one already in
// progress (idempotent — safe to call again after a page refresh).
app.post('/api/attendance-session/start', async (req, res) => {
  try {
    const classId = req.body.classId || 'class1';
    const { date } = getNowStrings();

    let session = await AttendanceSession.findOne({ classId, date });
    if (session) {
      return respond(res, 200, true, session.status === 'completed' ? 'Attendance already completed for today.' : 'Resuming today\'s attendance session.', { session });
    }

    const students = await Student.find({ classId }).sort({ studentId: 1 });
    if (students.length === 0) {
      return respond(res, 400, false, 'No students are registered in this class yet.');
    }

    session = new AttendanceSession({
      classId,
      date,
      rollOrder: students.map(s => s.studentId),
      currentIndex: 0,
      status: 'in_progress',
      results: students.map(s => ({ studentId: s.studentId, studentName: s.name, status: 'pending', attempts: [], retryUsed: false }))
    });
    await session.save();

    return respond(res, 200, true, `Attendance started for ${students.length} student(s).`, { session });
  } catch (err) {
    console.error('Attendance-session start error:', err);
    respond(res, 500, false, 'Server error starting attendance session: ' + err.message);
  }
});


// GET /api/attendance-session/today?classId=...
// Read-only peek — returns today's session for this class if one exists,
// WITHOUT creating one. Used to silently resume/gate UI state on page
// load; the only way a session actually gets created is the explicit
// "Start Attendance For Today" click (POST /start above).
app.get('/api/attendance-session/today', async (req, res) => {
  try {
    const classId = req.query.classId || 'class1';
    const { date } = getNowStrings();
    const session = await AttendanceSession.findOne({ classId, date });
    return respond(res, 200, true, session ? 'Found.' : 'No session yet today.', { session: session || null });
  } catch (err) {
    respond(res, 500, false, 'Server error checking today\'s session: ' + err.message);
  }
});


// GET /api/attendance-session/:id
// Full current state — used for polling/resuming the roll-call UI.
app.get('/api/attendance-session/:id', async (req, res) => {
  try {
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return respond(res, 404, false, 'Attendance session not found.');
    return respond(res, 200, true, 'Session fetched.', { session });
  } catch (err) {
    respond(res, 500, false, 'Server error fetching session: ' + err.message);
  }
});


// POST /api/attendance-session/:id/submit
// Verifies the CURRENT student in roll order against a freshly captured
// voice+face+lipsync clip. One retry is allowed before the student is
// marked absent/unverified and the system auto-advances to the next
// roll number.
// multipart fields: clip (video+audio), faceFrame (jpeg snapshot)
app.post('/api/attendance-session/:id/submit', uploadTemp.fields([
  { name: 'clip', maxCount: 1 },
  { name: 'faceFrame', maxCount: 1 }
]), async (req, res) => {
  const clipFile = req.files && req.files['clip'] ? req.files['clip'][0] : null;
  const faceFile = req.files && req.files['faceFrame'] ? req.files['faceFrame'][0] : null;
  const clipPath = clipFile ? clipFile.path : null;
  const facePath = faceFile ? faceFile.path : null;

  try {
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) {
      cleanupMultimodalFiles([clipPath, facePath]);
      return respond(res, 404, false, 'Attendance session not found.');
    }
    if (session.status === 'completed') {
      cleanupMultimodalFiles([clipPath, facePath]);
      return respond(res, 400, false, 'This attendance session is already completed.');
    }
    if (session.currentIndex >= session.rollOrder.length) {
      session.status = 'completed';
      session.completedAt = new Date();
      await session.save();
      cleanupMultimodalFiles([clipPath, facePath]);
      return respond(res, 200, true, 'Attendance completed.', { session });
    }
    if (!clipPath || !facePath) {
      cleanupMultimodalFiles([clipPath, facePath]);
      return respond(res, 400, false, 'Both "clip" (voice+video) and "faceFrame" (photo) are required.');
    }

    const currentStudentId = session.rollOrder[session.currentIndex];
    const student = await Student.findOne({ studentId: currentStudentId });
    const resultEntry = session.results.find(r => r.studentId === currentStudentId);

    if (!student || !resultEntry) {
      cleanupMultimodalFiles([clipPath, facePath]);
      return respond(res, 500, false, 'Internal error: current student record not found.');
    }

    console.log(`[RollCall] Verifying ${student.studentId} (${student.name}) — attempt ${resultEntry.attempts.length + 1}…`);

    // 1. Voice — must match THIS specific student
    let voiceMatched = false, voiceScore = 0;
    const voicePred = await runPythonPredictor(clipPath);
    if (voicePred.ok && voicePred.predictions && voicePred.predictions.length > 0) {
      const top = voicePred.predictions[0];
      voiceScore = Math.round((top.confidence || 0) * 100);
      voiceMatched = top.speaker_id.toUpperCase() === student.studentId.toUpperCase();
    }

    // 2. Face — must match THIS specific student's enrolled embeddings
    let faceMatched = false, faceScore = 0;
    if (student.isFaceRegistered && student.faceEmbeddings && student.faceEmbeddings.length > 0) {
      const faceResult = await runPythonFacePrediction(facePath, student.faceEmbeddings);
      if (faceResult && faceResult.ok) {
        faceMatched = Boolean(faceResult.matched);
        faceScore = faceResult.confidence || 0;
      }
    }

    // 3. Lip-sync / liveness — mouth movement must match the audio in this same clip
    let livenessPassed = false, livenessScore = 0, livenessMsg = '';
    const lyResult = await runPythonLipSyncVerification(clipPath, clipPath);
    if (lyResult.ok !== false) {
      livenessPassed = Boolean(lyResult.liveness_passed);
      livenessScore = lyResult.liveness_confidence || 0;
      livenessMsg = lyResult.error || lyResult.message || '';
    } else {
      livenessMsg = lyResult.error || 'Liveness check failed.';
    }

    cleanupMultimodalFiles([clipPath, facePath]);

    const passed = voiceMatched && faceMatched && livenessPassed;
    const failReasons = [];
    if (!voiceMatched) failReasons.push('voice did not match');
    if (!faceMatched) failReasons.push('face did not match');
    if (!livenessPassed) failReasons.push(livenessMsg || 'liveness/lip-sync check failed');

    resultEntry.attempts.push({
      voiceScore, faceScore, lipsyncScore: livenessScore,
      passed, failReason: passed ? null : failReasons.join('; ')
    });

    let outcome; // 'present' | 'retry' | 'absent'

    if (passed) {
      resultEntry.status = 'present';
      outcome = 'present';

      const { date, time } = getNowStrings();
      const existing = await Attendance.findOne({ studentId: student.studentId, date });
      if (!existing) {
        await new Attendance({
          student: student._id,
          studentId: student.studentId,
          studentName: student.name,
          date, time,
          method: 'roll_call_multimodal',
          confidence: Math.round((voiceScore + faceScore + livenessScore) / 3),
          voiceScore, faceScore, livenessScore,
          subject: session.classId,
          sessionId: session._id
        }).save();
      }
      session.currentIndex += 1;

    } else if (!resultEntry.retryUsed) {
      resultEntry.retryUsed = true;
      outcome = 'retry';
      // currentIndex does NOT advance — same student gets one more try

    } else {
      resultEntry.status = 'absent';
      outcome = 'absent';
      session.currentIndex += 1;
    }

    if (session.currentIndex >= session.rollOrder.length) {
      session.status = 'completed';
      session.completedAt = new Date();
    }

    await session.save();

    return respond(res, 200, true,
      outcome === 'present' ? `✓ ${student.name} verified — present.` :
      outcome === 'retry' ? `Verification failed for ${student.name} — one retry allowed.` :
      `${student.name} could not be verified after retry — marked absent.`,
      {
        outcome,
        studentId: student.studentId,
        studentName: student.name,
        scores: { voiceScore, faceScore, livenessScore },
        failReasons: passed ? [] : failReasons,
        session
      }
    );

  } catch (err) {
    cleanupMultimodalFiles([clipPath, facePath]);
    console.error('Attendance-session submit error:', err);
    respond(res, 500, false, 'Server error during verification: ' + err.message);
  }
});


// POST /api/attendance-session/:id/override
// Faculty manual override for a student, AFTER the roll call completes.
// Body: { studentId, present: boolean, reason }
app.post('/api/attendance-session/:id/override', async (req, res) => {
  try {
    const session = await AttendanceSession.findById(req.params.id);
    if (!session) return respond(res, 404, false, 'Attendance session not found.');
    if (session.status !== 'completed') {
      return respond(res, 400, false, 'Overrides are only allowed after the roll call is completed.');
    }

    const { studentId, present, reason } = req.body;
    const resultEntry = session.results.find(r => r.studentId === (studentId || '').toUpperCase());
    if (!resultEntry) return respond(res, 404, false, 'Student not found in this session.');

    resultEntry.status = present ? 'present' : 'absent';
    resultEntry.facultyOverride = true;
    resultEntry.overrideReason = reason || null;
    resultEntry.overriddenAt = new Date();
    await session.save();

    const student = await Student.findOne({ studentId: resultEntry.studentId });

    if (present) {
      const existing = await Attendance.findOne({ studentId: resultEntry.studentId, date: session.date });
      if (!existing && student) {
        const { time } = getNowStrings();
        await new Attendance({
          student: student._id,
          studentId: resultEntry.studentId,
          studentName: resultEntry.studentName,
          date: session.date, time,
          method: 'faculty_override',
          confidence: 0,
          subject: session.classId,
          sessionId: session._id,
          facultyOverride: true,
          overrideReason: reason || null
        }).save();
      } else if (existing) {
        existing.facultyOverride = true;
        existing.overrideReason = reason || null;
        await existing.save();
      }
    } else {
      await Attendance.deleteOne({ studentId: resultEntry.studentId, date: session.date });
    }

    return respond(res, 200, true, `${resultEntry.studentName} marked ${present ? 'present' : 'absent'} by faculty override.`, { session });
  } catch (err) {
    console.error('Attendance-session override error:', err);
    respond(res, 500, false, 'Server error applying override: ' + err.message);
  }
});



app.post('/api/class-session/start', async (req, res) => {
  try {
    const { classId, className, facultyId, facultyName } = req.body;
    const cid = classId || 'class1';
    const cname = className || (cid === 'class1' ? 'CS101 — Algorithms' : 'IT202 — Networks');

    await ClassSession.updateMany({ classId: cid, activeStatus: true }, { activeStatus: false, endTime: new Date() });

    const session = new ClassSession({
      sessionId: `sess-${Date.now()}-${Math.round(Math.random()*1e4)}`,
      classId: cid,
      className: cname,
      facultyId: facultyId || 'FAC001',
      facultyName: facultyName || 'Faculty Instructor',
      activeStatus: true,
      startTime: new Date()
    });
    await session.save();

    return respond(res, 200, true, 'Live class session started.', { session });
  } catch (err) {
    console.error('Start class session error:', err);
    respond(res, 500, false, 'Server error starting class session.');
  }
});

// POST /api/class-session/stop
app.post('/api/class-session/stop', async (req, res) => {
  try {
    const { sessionId, classId } = req.body;
    const filter = sessionId ? { sessionId } : { classId: classId || 'class1', activeStatus: true };
    await ClassSession.updateMany(filter, { activeStatus: false, endTime: new Date() });
    return respond(res, 200, true, 'Class session closed.');
  } catch (err) {
    respond(res, 500, false, 'Error stopping class session.');
  }
});

// POST /api/class-session/activity
app.post('/api/class-session/activity', uploadTemp.single('audio'), async (req, res) => {
  if (!req.file) return respond(res, 400, false, 'No audio activity chunk uploaded.');
  const tempPath = req.file.path;
  const { sessionId, classId } = req.body;

  try {
    const pred = await runPythonPredictor(tempPath);
    let identifiedStudent = null;
    let confidence = 85;

    if (pred.ok && pred.predictions && pred.predictions.length > 0) {
      const top = pred.predictions[0];
      identifiedStudent = await Student.findOne({ studentId: top.speaker_id.toUpperCase() });
      confidence = Math.round((top.confidence || 0.85) * 100);
    }
    // NOTE: previously fell back to "any registered student" when the
    // voice wasn't recognized — that could misattribute activity to the
    // wrong person. Now it simply reports no detection instead of guessing.

    if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch {}

    if (!identifiedStudent) {
      return respond(res, 200, true, 'No recognized speaker voice detected in chunk.', { detected: false });
    }

    const event = new ActivityEvent({
      sessionId: sessionId || 'default-session',
      classId: classId || identifiedStudent.classId || 'class1',
      student: identifiedStudent._id,
      studentId: identifiedStudent.studentId,
      studentName: identifiedStudent.name,
      confidence,
      timestamp: new Date()
    });
    await event.save();

    return respond(res, 200, true, `Speech detected from ${identifiedStudent.name}`, {
      detected: true,
      event: {
        studentId: identifiedStudent.studentId,
        studentName: identifiedStudent.name,
        confidence,
        timestamp: event.timestamp
      }
    });
  } catch (err) {
    if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch {}
    respond(res, 500, false, 'Error processing voice activity: ' + err.message);
  }
});

// GET /api/class-session/:sessionId/dashboard
app.get('/api/class-session/:sessionId/dashboard', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const classId = req.query.classId || 'class1';

    const classStudents = await Student.find({ classId });
    const events = await ActivityEvent.find({ classId }).sort({ timestamp: -1 });

    const now = new Date();
    const studentStatusMap = {};

    classStudents.forEach(s => {
      const studentEvents = events.filter(e => e.studentId === s.studentId);
      const latest = studentEvents.length > 0 ? studentEvents[0] : null;
      
      let status = 'No Response';
      let lastActivityTime = null;

      if (latest) {
        lastActivityTime = latest.timestamp;
        const diffMins = (now - new Date(latest.timestamp)) / (1000 * 60);
        if (diffMins <= 3.0) {
          status = 'Recently Active';
        } else {
          status = 'Low Activity';
        }
      }

      studentStatusMap[s.studentId] = {
        studentId: s.studentId,
        name: s.name,
        lastActivity: lastActivityTime,
        status,
        confidence: latest ? latest.confidence : 0,
        eventCount: studentEvents.length
      };
    });

    const studentsList = Object.values(studentStatusMap);
    const activeCount = studentsList.filter(s => s.status === 'Recently Active').length;
    const lowCount = studentsList.filter(s => s.status === 'Low Activity').length;
    const noResponseCount = studentsList.filter(s => s.status === 'No Response').length;

    return respond(res, 200, true, 'Classroom live activity dashboard fetched.', {
      dashboard: {
        classId,
        totalStudents: classStudents.length,
        activeCount,
        lowActivityCount: lowCount,
        noResponseCount,
        recentSpeakers: events.slice(0, 5).map(e => ({ studentName: e.studentName, time: e.timestamp, confidence: e.confidence })),
        students: studentsList
      }
    });

  } catch (err) {
    console.error('Classroom dashboard error:', err);
    respond(res, 500, false, 'Error fetching classroom dashboard.');
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/class-session/reset-attendance
// Clears TODAY's attendance + activity events for one class only
// (does not touch other classes or past days). Used by the
// faculty "Reset" button on class.html.
// ────────────────────────────────────────────────────────────
app.post('/api/class-session/reset-attendance', async (req, res) => {
  try {
    const classId = req.body.classId || 'class1';
    const { date } = getNowStrings();

    const classStudents = await Student.find({ classId }).select('studentId');
    const studentIds = classStudents.map(s => s.studentId);

    if (studentIds.length === 0) {
      return respond(res, 200, true, 'No students in this class — nothing to reset.', {
        attendanceCleared: 0,
        activityCleared: 0
      });
    }

    const attendanceResult = await Attendance.deleteMany({ studentId: { $in: studentIds }, date });
    const activityResult = await ActivityEvent.deleteMany({ classId });

    return respond(res, 200, true, `Reset complete for ${classId}. Cleared ${attendanceResult.deletedCount} attendance record(s) and ${activityResult.deletedCount} activity event(s).`, {
      attendanceCleared: attendanceResult.deletedCount,
      activityCleared: activityResult.deletedCount
    });
  } catch (err) {
    console.error('Reset-attendance error:', err);
    respond(res, 500, false, 'Server error while resetting attendance.');
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
// POST /api/request-biometric-update
// A locked-in student can't unlock their own profile — instead this
// sends a request to faculty for review. Replaces self-service unlock.
// ────────────────────────────────────────────────────────────
app.post('/api/request-biometric-update', protect, async (req, res) => {
  try {
    const student = req.student;

    if (!student.isRegistrationLocked) {
      return respond(res, 400, false, 'Your profile is not locked — nothing to request.');
    }
    if (student.biometricUpdateRequest && student.biometricUpdateRequest.status === 'pending') {
      return respond(res, 200, true, 'Your request has already reached your faculty and is awaiting review.', {
        request: student.biometricUpdateRequest
      });
    }

    student.biometricUpdateRequest = {
      status: 'pending',
      reason: (req.body && req.body.reason) || 'Student requested biometric re-enrollment.',
      requestedAt: new Date(),
      respondedAt: null,
      responseNote: null
    };
    await student.save();

    return respond(res, 200, true, 'Your request has reached your faculty and is awaiting review.', {
      request: student.biometricUpdateRequest
    });
  } catch (err) {
    console.error('Request-biometric-update error:', err);
    respond(res, 500, false, 'Server error while sending your request.');
  }
});


// ────────────────────────────────────────────────────────────
// GET /api/faculty/biometric-requests
// List students with a pending (or all, if ?status=all) biometric
// update request, for the faculty dashboard panel.
// ────────────────────────────────────────────────────────────
app.get('/api/faculty/biometric-requests', async (req, res) => {
  try {
    const filter = req.query.status === 'all'
      ? { 'biometricUpdateRequest.status': { $ne: 'none' } }
      : { 'biometricUpdateRequest.status': 'pending' };

    const students = await Student.find(filter)
      .select('name studentId email classId biometricUpdateRequest')
      .sort({ 'biometricUpdateRequest.requestedAt': 1 });

    return respond(res, 200, true, `${students.length} request(s) found.`, { requests: students });
  } catch (err) {
    console.error('Biometric-requests list error:', err);
    respond(res, 500, false, 'Server error fetching requests.');
  }
});


// ────────────────────────────────────────────────────────────
// POST /api/faculty/biometric-requests/:studentId/respond
// Faculty approves (unlocks the profile so the student can re-enroll
// via enroll.html) or denies a pending request.
// Body: { approve: boolean, note?: string }
// NOTE: unprotected, same caveat as other faculty routes — no separate
// faculty auth system exists in this project yet.
// ────────────────────────────────────────────────────────────
app.post('/api/faculty/biometric-requests/:studentId/respond', async (req, res) => {
  try {
    const student = await Student.findOne({ studentId: req.params.studentId.toUpperCase() });
    if (!student) return respond(res, 404, false, 'Student not found.');

    const approve = Boolean(req.body.approve);
    const note = req.body.note || null;

    student.biometricUpdateRequest.status = approve ? 'approved' : 'denied';
    student.biometricUpdateRequest.respondedAt = new Date();
    student.biometricUpdateRequest.responseNote = note;

    if (approve) {
      student.isRegistrationLocked = false;
      student.registrationLockedAt = null;
    }
    await student.save();

    return respond(res, 200, true,
      approve ? `${student.name}'s request was approved — they can now re-enroll.` : `${student.name}'s request was denied.`,
      { student: { studentId: student.studentId, biometricUpdateRequest: student.biometricUpdateRequest, isRegistrationLocked: student.isRegistrationLocked } }
    );
  } catch (err) {
    console.error('Biometric-request respond error:', err);
    respond(res, 500, false, 'Server error while responding to request.');
  }
});


// ────────────────────────────────────────────────────────────
// GET /api/student/activity-summary
// Read-only participation summary for the logged-in student, grouped
// by class — powers the student dashboard's activity section.
// ────────────────────────────────────────────────────────────
app.get('/api/student/activity-summary', protect, async (req, res) => {
  try {
    const studentId = req.student.studentId;
    const events = await ActivityEvent.find({ studentId }).sort({ timestamp: -1 });

    const byClass = {};
    for (const ev of events) {
      if (!byClass[ev.classId]) {
        byClass[ev.classId] = { classId: ev.classId, verifiedResponses: 0, lastActive: null, avgConfidence: 0, _confSum: 0 };
      }
      const bucket = byClass[ev.classId];
      bucket.verifiedResponses += 1;
      bucket._confSum += (ev.confidence || 0);
      if (!bucket.lastActive || ev.timestamp > bucket.lastActive) bucket.lastActive = ev.timestamp;
    }

    const classSummaries = Object.values(byClass).map(b => ({
      classId: b.classId,
      verifiedResponses: b.verifiedResponses,
      lastActive: b.lastActive,
      // Simple participation proxy, not a precise attendance metric —
      // capped at 100, ~8 points per verified response.
      activityScore: Math.min(100, Math.round(b.verifiedResponses * 8)),
      avgConfidence: b.verifiedResponses > 0 ? Math.round(b._confSum / b.verifiedResponses) : 0
    }));

    const overallScore = classSummaries.length > 0
      ? Math.round(classSummaries.reduce((sum, c) => sum + c.activityScore, 0) / classSummaries.length)
      : 0;

    return respond(res, 200, true, 'Activity summary fetched.', {
      overallScore,
      totalVerifiedResponses: events.length,
      classes: classSummaries
    });
  } catch (err) {
    console.error('Student activity-summary error:', err);
    respond(res, 500, false, 'Server error fetching activity summary.');
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
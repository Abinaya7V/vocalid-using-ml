// ============================================================
//  VocalID – Frontend API Bridge  (v2 – database-driven)
//  All student data now comes from MongoDB via the REST API.
//  No hardcoded student lists remain.
// ============================================================

/* ── Backend base URL ──────────────────────────────────────── */
const API_URL = "http://localhost:5000/api";

/* ── Token helpers (localStorage) ─────────────────────────── */
const Auth = {
  saveToken(token) { localStorage.setItem('vocalid_token', token); },
  getToken() { return localStorage.getItem('vocalid_token'); },
  clearToken() { localStorage.removeItem('vocalid_token'); },
  saveStudent(data) { localStorage.setItem('vocalid_student', JSON.stringify(data)); },
  getStudent() {
    const v = localStorage.getItem('vocalid_student');
    return v ? JSON.parse(v) : null;
  },
  clearStudent() { localStorage.removeItem('vocalid_student'); },
  isLoggedIn() { return !!this.getToken(); }
};

/* ── Core fetch wrapper ────────────────────────────────────── */
async function apiFetch(path, options = {}) {
  const token = Auth.getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_URL + path, { ...options, headers });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

/* ── Toast / alert helper ──────────────────────────────────── */
function showToast(message, type = 'success') {
  const existing = document.getElementById('vocalid-toast');
  if (existing) existing.remove();
  const colors = {
    success: 'background:rgba(0,229,160,.15);border:1px solid rgba(0,229,160,.35);color:#00e5a0;',
    error: 'background:rgba(255,77,109,.15);border:1px solid rgba(255,77,109,.35);color:#ff4d6d;',
    info: 'background:rgba(0,212,255,.15);border:1px solid rgba(0,212,255,.35);color:#00d4ff;'
  };
  const toast = document.createElement('div');
  toast.id = 'vocalid-toast';
  toast.style.cssText = `
    position:fixed;top:24px;right:24px;z-index:9999;
    padding:14px 20px;border-radius:10px;font-size:.85rem;
    max-width:340px;line-height:1.5;backdrop-filter:blur(12px);
    box-shadow:0 4px 24px rgba(0,0,0,.4);
    animation:fadeInDown .3s ease;
    ${colors[type] || colors.info}
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

(function injectToastStyle() {
  if (document.getElementById('vocalid-toast-style')) return;
  const s = document.createElement('style');
  s.id = 'vocalid-toast-style';
  s.textContent = `@keyframes fadeInDown{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:translateY(0)}}`;
  document.head.appendChild(s);
})();

// ============================================================
//  STUDENT API FUNCTIONS
// ============================================================

/**
 * POST /api/register
 */
async function registerStudent(name, studentId, email, password, classId = 'class1') {
  try {
    const { ok, data } = await apiFetch('/register', {
      method: 'POST',
      body: JSON.stringify({ name, studentId, email, password, classId })
    });
    if (ok && data.success) {
      Auth.saveToken(data.token);
      Auth.saveStudent(data.student);
      VocalID.set('student_info', { name: data.student.name, roll: data.student.studentId, email: data.student.email, classId: data.student.classId });
      showToast('Registration successful! Welcome, ' + data.student.name + '.', 'success');
      return true;
    }
    showToast(data.message || 'Registration failed.', 'error');
    return false;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return false;
  }
}

/**
 * POST /api/login
 */
async function loginStudent(studentId, password) {
  try {
    const { ok, data } = await apiFetch('/login', {
      method: 'POST',
      body: JSON.stringify({ studentId, password })
    });
    if (ok && data.success) {
      Auth.saveToken(data.token);
      Auth.saveStudent(data.student);
      VocalID.set('student_info', { name: data.student.name, roll: data.student.studentId, email: data.student.email, dept: '' });
      showToast('Welcome back, ' + data.student.name + '!', 'success');
      const dest = data.student.isRegistrationLocked ? 'student-dashboard.html' : 'enroll.html';
      setTimeout(() => { window.location.href = dest; }, 800);
      return true;
    }
    showToast(data.message || 'Invalid credentials.', 'error');
    return false;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return false;
  }
}

/**
 * POST /api/upload-voice
 */
async function uploadVoiceSample(audioBlob, filename = 'voice.wav') {
  try {
    const token = Auth.getToken();
    if (!token) { showToast('You must be logged in to upload a voice sample.', 'error'); return false; }
    const formData = new FormData();
    formData.append('voiceSample', audioBlob, filename);
    const res = await fetch(API_URL + '/upload-voice', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });
    const data = await res.json();
    if (res.ok && data.success) {
      const student = Auth.getStudent();
      if (student) { student.isVoiceRegistered = true; Auth.saveStudent(student); }
      VocalID.set('student_enrolled', true);
      showToast('Voice sample uploaded successfully!', 'success');
      return true;
    }
    showToast(data.message || 'Voice upload failed.', 'error');
    return false;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return false;
  }
}

/**
 * POST /api/upload-face
 * @param {Array<Blob>} imageBlobs - Array of face image Blobs
 * @returns {Promise<object|null>}
 */
async function uploadFaceSamples(imageBlobs) {
  try {
    const token = Auth.getToken();
    if (!token) {
      showToast('You must be logged in to register face samples.', 'error');
      return null;
    }
    const formData = new FormData();
    const blobs = Array.isArray(imageBlobs) ? imageBlobs : [imageBlobs];
    blobs.forEach((blob, idx) => {
      const ext = blob.type.includes('png') ? 'png' : 'jpg';
      formData.append('faceSamples', blob, `sample_${idx + 1}.${ext}`);
    });

    const res = await fetch(API_URL + '/upload-face', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });

    const data = await res.json();
    if (res.ok && data.success) {
      const student = Auth.getStudent();
      if (student) {
        student.isFaceRegistered = true;
        student.faceRegisteredAt = data.face?.registeredAt || new Date();
        Auth.saveStudent(student);
      }
      VocalID.set('face_enrolled', true);
      showToast('✅ Face profile created successfully!', 'success');
      return data;
    }
    showToast(data.message || 'Face enrollment failed.', 'error');
    return data;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return null;
  }
}

/**
 * POST /api/verify-face
 * @param {Blob} imageBlob - Live face image snapshot Blob
 * @returns {Promise<object|null>}
 */
async function verifyFace(imageBlob) {
  try {
    const token = Auth.getToken();
    if (!token) {
      showToast('You must be logged in to verify your face.', 'error');
      return null;
    }
    const formData = new FormData();
    const ext = imageBlob.type && imageBlob.type.includes('png') ? 'png' : 'jpg';
    formData.append('faceSample', imageBlob, `live_face.${ext}`);

    const res = await fetch(API_URL + '/verify-face', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });

    const data = await res.json();
    if (res.ok && data.success) {
      return data;
    }
    showToast(data.message || 'Face verification failed.', 'error');
    return data;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return null;
  }
}

/**
 * POST /api/check-liveness-sample
 * Quality gate used during enrollment — checks a just-recorded clip for
 * real lip movement synced to its own audio. Nothing is saved by this
 * call; it just returns pass/fail so a bad take can be redone immediately.
 * @param {Blob} clipBlob - the recorded video+audio clip for one phrase
 * @returns {Promise<{passed:boolean, confidence?:number, reason?:string}|null>}
 */
async function checkLivenessSample(clipBlob) {
  try {
    const token = Auth.getToken();
    if (!token) { showToast('You must be logged in to enroll.', 'error'); return null; }

    const formData = new FormData();
    formData.append('clip', clipBlob, 'sample_clip.webm');

    const res = await fetch(API_URL + '/check-liveness-sample', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });

    const data = await res.json();
    if (res.ok && data.success) {
      return { passed: data.passed, confidence: data.confidence, reason: data.reason };
    }
    return { passed: false, reason: data.message || 'Liveness check request failed.' };
  } catch (err) {
    return { passed: false, reason: 'Cannot reach the server. Is the backend running?' };
  }
}

/**
 * POST /api/lock-registration
 * Finalizes enrollment — requires 2+ voice samples and a registered face.
 * Locks the profile so the student can't self-modify their biometrics
 * afterward.
 */
async function lockRegistration() {
  try {
    const token = Auth.getToken();
    if (!token) { showToast('You must be logged in to complete enrollment.', 'error'); return null; }

    const res = await fetch(API_URL + '/lock-registration', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      const student = Auth.getStudent();
      if (student) { student.isRegistrationLocked = true; Auth.saveStudent(student); }
      showToast(data.message || 'Enrollment complete!', 'success');
      return data;
    }
    showToast(data.message || 'Could not complete enrollment yet.', 'error');
    return data;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return null;
  }
}

/**
 * GET /api/me — fresh profile (includes lock status + request status)
 */
async function fetchMyProfile() {
  try {
    const { ok, data } = await apiFetch('/me', { method: 'GET' });
    if (ok && data.success) return data.student;
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * GET /api/attendance-report?studentId=...
 */
async function fetchMyAttendance(studentId) {
  try {
    const { ok, data } = await apiFetch(`/attendance-report?studentId=${encodeURIComponent(studentId)}`, { method: 'GET' });
    if (ok && data.success) return data;
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * GET /api/student/activity-summary
 */
async function fetchMyActivitySummary() {
  try {
    const { ok, data } = await apiFetch('/student/activity-summary', { method: 'GET' });
    if (ok && data.success) return data;
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * POST /api/request-biometric-update
 * Students can't unlock their own profile — this sends a request to
 * faculty instead.
 */
async function requestBiometricUpdate(reason) {
  try {
    const { ok, data } = await apiFetch('/request-biometric-update', {
      method: 'POST',
      body: JSON.stringify({ reason })
    });
    if (ok && data.success) {
      showToast(data.message || 'Your request has reached your faculty.', 'success');
      return data;
    }
    showToast(data.message || 'Could not send your request.', 'error');
    return data;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return null;
  }
}

/**
 * POST /api/process-classroom-multimodal
 * Faculty live 3-factor multimodal (Voice + Face + LipSync) verification
 * @param {Blob} audioBlob - Audio recording blob
 * @param {Blob} faceImageBlob - Live camera frame image blob
 * @param {Blob} videoClipBlob - Live video stream recording clip blob
 * @param {string} subject - Subject / class name
 * @returns {Promise<object|null>}
 */
async function processClassroomMultimodal(audioBlob, faceImageBlob, videoClipBlob = null, subject = 'General') {
  try {
    const formData = new FormData();
    if (audioBlob) formData.append('audio', audioBlob, 'classroom_voice.webm');
    if (faceImageBlob) formData.append('faceFrame', faceImageBlob, 'classroom_face.jpg');
    if (videoClipBlob) formData.append('videoClip', videoClipBlob, 'classroom_video.webm');
    if (subject) formData.append('subject', subject);

    const res = await fetch(API_URL + '/process-classroom-multimodal', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || '✅ 3-Factor Multimodal Attendance verified.', 'success');
      return data;
    }
    showToast(data.message || 'Multimodal verification failed.', 'error');
    return data;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return null;
  }
}

/**
 * POST /api/mark-attendance
 * @param {object} opts - { subject, method, audioBlob, audioBlobName }
 *   audioBlob     – Blob/File of the live recording (enables full ML verification)
 *   subject       – subject name (default 'General')
 */
/**
 * Self-service attendance marking has been removed. Students can no
 * longer mark their own attendance — it is recorded automatically by
 * the faculty-run roll-call session or live class session.
 */
async function markAttendance() {
  showToast('Attendance is marked automatically by your instructor during class — you can\'t mark it yourself.', 'info');
  return null;
}

/**
 * POST /api/process-classroom-audio
 * @param {Blob} audioBlob
 * @param {string} subject
 * @returns {Promise<object|null>}
 */
/**
 * POST /api/class-session/activity
 * Live Session continuous monitoring — voice-only speaker detection for
 * classroom participation tracking. Deliberately does NOT verify face or
 * lip-sync, and NEVER marks attendance — that's the roll-call engine's
 * job. This only logs an ActivityEvent when a registered voice is heard.
 * @param {Blob} audioBlob - short audio/video clip (audio track is what matters)
 * @param {string} classId
 * @param {string} sessionId
 */
async function logVoiceActivity(audioBlob, classId, sessionId) {
  try {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'activity_chunk.webm');
    if (classId) formData.append('classId', classId);
    if (sessionId) formData.append('sessionId', sessionId);

    const res = await fetch(API_URL + '/class-session/activity', {
      method: 'POST',
      body: formData
    });
    return await res.json();
  } catch (err) {
    console.warn('Voice activity logging failed:', err.message);
    return null;
  }
}

async function processClassroomAudio(audioBlob, subject = 'General') {
  try {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'classroom.webm');
    formData.append('subject', subject);

    const res = await fetch(API_URL + '/process-classroom-audio', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ ${data.detected_count} student(s) identified.`, 'success');
      return data;
    }
    showToast(data.message || 'Processing failed.', 'error');
    return null;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return null;
  }
}

/**
 * GET /api/attendance-report
 */
async function fetchAttendanceReport(filters = {}) {
  try {
    const params = new URLSearchParams();
    if (filters.studentId) params.set('studentId', filters.studentId);
    if (filters.date) params.set('date', filters.date);
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    if (filters.subject) params.set('subject', filters.subject);
    const query = params.toString() ? '?' + params.toString() : '';
    const { ok, data } = await apiFetch('/attendance-report' + query, { method: 'GET' });
    if (ok && data.success) return { summary: data.summary, records: data.records };
    showToast(data.message || 'Could not fetch attendance report.', 'error');
    return null;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return null;
  }
}

/**
 * GET /api/students
 * Returns all students registered in the database.
 * @param {object} filters  Optional: { search, isVoiceRegistered }
 * @returns {Promise<Array>}  Array of student objects (empty array on error)
 */
async function fetchStudents(filters = {}) {
  try {
    const params = new URLSearchParams();
    if (filters.classId !== undefined) params.set('classId', filters.classId);
    if (filters.search !== undefined) params.set('search', filters.search);
    if (filters.isVoiceRegistered !== undefined) params.set('isVoiceRegistered', filters.isVoiceRegistered);
    const query = params.toString() ? '?' + params.toString() : '';
    const { ok, data } = await apiFetch('/students' + query, { method: 'GET' });
    if (ok && data.success) return data.students || [];
    return [];
  } catch (err) {
    return [];
  }
}

/**
 * GET /api/students/count
 * @returns {Promise<number>}
 */
async function fetchStudentCount() {
  try {
    const { ok, data } = await apiFetch('/students/count', { method: 'GET' });
    return (ok && data.success) ? data.count : 0;
  } catch { return 0; }
}

/**
 * DELETE /api/students  — wipe ALL students + attendance + voice files
 * Faculty-only system reset.
 * @returns {Promise<boolean>}
 */
async function resetSystem() {
  try {
    const res = await fetch(API_URL + '/students', { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      // Clear all local caches too
      sessionStorage.clear();
      showToast('✅ ' + data.message, 'success');
      return true;
    }
    showToast(data.message || 'Reset failed.', 'error');
    return false;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return false;
  }
}

// ============================================================
//  SESSION / AUTH HELPERS  (legacy-compatible)
// ============================================================
const VocalID = {
  set(key, value) {
    sessionStorage.setItem('vocalid_' + key, JSON.stringify(value));
  },
  get(key, fallback = null) {
    const v = sessionStorage.getItem('vocalid_' + key);
    return v !== null ? JSON.parse(v) : fallback;
  },
  requireFacultyAuth() {
    if (!this.get('faculty_logged_in')) {
      window.location.href = 'faculty-login.html';
      return false;
    }
    return true;
  },
  requireStudentAuth() {
    if (!this.get('student_info') && !Auth.isLoggedIn()) {
      window.location.href = 'student-login.html';
      return false;
    }
    return true;
  },
  // Kept for backward compatibility — delegate to the API now
  // Returns a cached copy stored in sessionStorage (set after API load)
  getStudents(classId) {
    const cached = this.get('db_students_' + classId);
    return cached || [];
  },
  saveStudents(classId, data) {
    this.set('db_students_' + classId, data);
  },
  resetStudents(classId) {
    const students = this.getStudents(classId);
    const reset = students.map(s => ({ ...s, status: 'pending', confidence: 0 }));
    this.saveStudents(classId, reset);
    return reset;
  }
};
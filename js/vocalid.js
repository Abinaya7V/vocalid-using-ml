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
      setTimeout(() => { window.location.href = 'voice.html'; }, 800);
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
 * POST /api/mark-attendance
 * @param {object} opts - { subject, method, audioBlob, audioBlobName }
 *   audioBlob     – Blob/File of the live recording (enables full ML verification)
 *   subject       – subject name (default 'General')
 */
async function markAttendance(opts = {}) {
  try {
    const token = Auth.getToken();
    if (!token) {
      showToast('Please log in before marking attendance.', 'error');
      window.location.href = 'student-login.html';
      return false;
    }

    let res, data;

    if (opts.audioBlob) {
      // ── ML path: send voice recording as multipart ──────────────
      const ext = opts.audioBlob.type.includes('webm') ? 'webm' : 'ogg';
      const filename = opts.audioBlobName || `attendance.${ext}`;
      const formData = new FormData();
      formData.append('voiceSample', opts.audioBlob, filename);
      if (opts.subject) formData.append('subject', opts.subject);

      res = await fetch(API_URL + '/mark-attendance', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
    } else {
      // ── Degraded path: no audio, JSON body ──────────────────────
      res = await fetch(API_URL + '/mark-attendance', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: opts.subject || 'General', method: opts.method || 'manual' })
      });
    }

    data = await res.json();

    if (res.ok && data.success) {
      const conf = data.attendance?.confidence;
      const confStr = conf != null ? ` (${conf}% confidence)` : '';
      showToast('✅ Attendance marked successfully!' + confStr, 'success');
      return true;
    }
    if (res.status === 409) { showToast('ℹ️ Attendance already marked for today.', 'info'); return false; }
    if (res.status === 403) {
      const msg = data.message || 'Voice verification failed.';
      showToast('⚠️ ' + msg, 'error');
      return false;
    }
    showToast(data.message || 'Could not mark attendance.', 'error');
    return false;
  } catch (err) {
    showToast('Cannot reach the server. Is the backend running?', 'error');
    return false;
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

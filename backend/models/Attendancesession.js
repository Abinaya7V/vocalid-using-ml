const mongoose = require('mongoose');

// One entry per student in the roll order for this session.
const rollResultSchema = new mongoose.Schema({
  studentId: { type: String, required: true, uppercase: true },
  studentName: { type: String, required: true },
  status: { type: String, enum: ['pending', 'present', 'absent'], default: 'pending' },
  attempts: [{
    voiceScore: Number,
    faceScore: Number,
    lipsyncScore: Number,
    passed: Boolean,
    failReason: String,
    timestamp: { type: Date, default: Date.now }
  }],
  retryUsed: { type: Boolean, default: false },
  facultyOverride: { type: Boolean, default: false },
  overrideReason: { type: String, default: null },
  overriddenAt: { type: Date, default: null }
}, { _id: false });

const attendanceSessionSchema = new mongoose.Schema({
  classId: { type: String, required: true },
  date: { type: String, required: true },   // "YYYY-MM-DD" — one session per class per day
  rollOrder: [{ type: String }],             // ordered list of studentIds
  currentIndex: { type: Number, default: 0 },
  status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
  results: [rollResultSchema],
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

// One active/completed session per class per day
attendanceSessionSchema.index({ classId: 1, date: 1 }, { unique: true });

module.exports = mongoose.models.AttendanceSession || mongoose.model('AttendanceSession', attendanceSessionSchema);
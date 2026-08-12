const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  studentId: { type: String, required: true, uppercase: true },
  studentName: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  method: { type: String, default: 'multimodal' },
  confidence: { type: Number, default: 0 },
  voiceScore: { type: Number, default: 0 },
  faceScore: { type: Number, default: 0 },
  livenessScore: { type: Number, default: 0 },
  subject: { type: String, default: 'General' },
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AttendanceSession', default: null },
  facultyOverride: { type: Boolean, default: false },
  overrideReason: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Attendance || mongoose.model('Attendance', attendanceSchema);
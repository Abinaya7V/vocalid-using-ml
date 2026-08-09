const mongoose = require('mongoose');

const activityEventSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  classId: { type: String, required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  studentId: { type: String, required: true, uppercase: true },
  studentName: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  confidence: { type: Number, default: 0 },
  durationSeconds: { type: Number, default: 3 }
});

module.exports = mongoose.models.ActivityEvent || mongoose.model('ActivityEvent', activityEventSchema);

const mongoose = require('mongoose');

const classSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  classId: { type: String, required: true },
  className: { type: String, required: true },
  facultyId: { type: String, default: 'FAC001' },
  facultyName: { type: String, default: 'Dr. Smith' },
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date },
  activeStatus: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.ClassSession || mongoose.model('ClassSession', classSessionSchema);

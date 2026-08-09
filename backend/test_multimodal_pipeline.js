const { evaluateMultimodalFusion } = require('./services/fusionService');

console.log("=== VOCALID MULTIMODAL FUSION TEST ===");

// Test 1: All 3 Biometrics Pass
const res1 = evaluateMultimodalFusion({
  voiceScore: 91, voiceMatched: true,
  faceScore: 94, faceMatched: true,
  livenessScore: 87, livenessPassed: true
});
console.log("\n[Test 1] All Pass Vector:");
console.log(JSON.stringify(res1, null, 2));

if (!res1.verified || res1.finalScore !== 91) {
  console.error("❌ Test 1 Failed!");
  process.exit(1);
}

// Test 2: Static Photo Attack (Liveness Failed)
const res2 = evaluateMultimodalFusion({
  voiceScore: 95, voiceMatched: true,
  faceScore: 98, faceMatched: true,
  livenessScore: 0, livenessPassed: false, livenessMessage: "Static photo attack detected"
});
console.log("\n[Test 2] Liveness Failed Vector:");
console.log(JSON.stringify(res2, null, 2));

if (res2.verified) {
  console.error("❌ Test 2 Failed!");
  process.exit(1);
}

// Test 3: Voice Speaker Mismatch
const res3 = evaluateMultimodalFusion({
  voiceScore: 40, voiceMatched: false,
  faceScore: 92, faceMatched: true,
  livenessScore: 88, livenessPassed: true
});
console.log("\n[Test 3] Voice Mismatch Vector:");
console.log(JSON.stringify(res3, null, 2));

if (res3.verified) {
  console.error("❌ Test 3 Failed!");
  process.exit(1);
}

console.log("\n✅ ALL MULTIMODAL FUSION TESTS PASSED SUCCESSFULLY!");
